import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const HOME = os.homedir()
const PI_DIR = path.join(HOME, '.pi/agent')
const REPO_SEARCH_ROOTS = ['Projects', 'conductor/workspaces', '.warp/worktrees'].map((dir) => path.join(HOME, dir))

export type Agent = 'pi' | 'claude'

export type Skill = {
  id: string
  name: string
  description: string
  realDir: string
  // Main checkout of the repo the skill lives in. Repo skills only load inside that repo.
  repo?: string
  locations: { path: string; source: string; agents: Agent[] }[]
  agents: Agent[]
  files: { rel: string; size: number; modifiedAt: string }[]
  modifiedAt: string
}

type Root = { dir: string; source: string; agents: Agent[] }

export async function globalSkills(): Promise<Skill[]> {
  const roots: Root[] = [
    { dir: path.join(PI_DIR, 'skills'), source: 'Pi (~/.pi/agent/skills)', agents: ['pi'] },
    { dir: path.join(HOME, '.agents/skills'), source: 'Agent Skills (~/.agents/skills)', agents: ['pi'] },
    { dir: path.join(PI_DIR, 'pi-hermes-memory/skills'), source: 'Pi, self-learned (hermes)', agents: ['pi'] },
    { dir: path.join(HOME, '.claude/skills'), source: 'Claude Code (~/.claude/skills)', agents: ['claude'] },
    ...(await piPackageRoots()),
    ...(await claudePluginRoots()),
  ]
  return skillsFromRoots(roots)
}

// Pi packages load skills from the `pi.skills` entries in package.json, or from ./skills by convention.
async function piPackageRoots(): Promise<Root[]> {
  const settings = await readJson(path.join(PI_DIR, 'settings.json'))
  const roots: Root[] = []
  for (const spec of (settings?.packages ?? []) as string[]) {
    const dir = spec.startsWith('npm:')
      ? path.join(PI_DIR, 'npm/node_modules', spec.slice(4))
      : path.join(PI_DIR, 'git', spec.replace(/^git:/, ''))
    const manifest = await readJson(path.join(dir, 'package.json'))
    for (const rel of manifest?.pi?.skills ?? ['skills']) {
      roots.push({ dir: path.join(dir, rel), source: `Pi package ${spec}`, agents: ['pi'] })
    }
  }
  return roots
}

async function claudePluginRoots(): Promise<Root[]> {
  const settings = await readJson(path.join(HOME, '.claude/settings.json'))
  const installed = await readJson(path.join(HOME, '.claude/plugins/installed_plugins.json'))
  const roots: Root[] = []
  for (const [id, on] of Object.entries(settings?.enabledPlugins ?? {})) {
    const install = (installed?.plugins?.[id] ?? []).find((entry: any) => entry.scope === 'user')
    if (on && install) roots.push({ dir: path.join(install.installPath, 'skills'), source: `Claude plugin ${id}`, agents: ['claude'] })
  }
  return roots
}

type Repo = { name: string; path: string; branch: string; lastCommitAt: string; worktrees: string[]; skills: Skill[] }

// Repos with a commit by the git user, on any branch, in the last `days` days. Worktrees of one repo
// are grouped, and skills are read from the main checkout.
export async function recentRepos(days: number): Promise<Repo[]> {
  const email = (await git(HOME, 'config', '--global', 'user.email')).trim()
  const { stdout } = await exec('find', [...REPO_SEARCH_ROOTS, '-maxdepth', '4', '(', '-name', 'node_modules', '-o', '-name', '.git', ')', '-prune', '-name', '.git', '-print'])
    .catch((error) => ({ stdout: String(error.stdout ?? '') }))

  const commonDirs = new Set<string>()
  await eachLimit(stdout.split('\n').filter(Boolean), 16, async (gitPath) => {
    commonDirs.add((await git(path.dirname(gitPath), 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim())
  })

  const repos: Repo[] = []
  await eachLimit([...commonDirs].filter((dir) => dir.endsWith('/.git')), 16, async (commonDir) => {
    const repoPath = path.dirname(commonDir)
    const lastCommitAt = (await git(repoPath, 'log', '-1', '--all', `--since=${days}.days`, `--author=${email}`, '--format=%cI')).trim()
    if (!lastCommitAt) return
    const worktrees = (await git(repoPath, 'worktree', 'list', '--porcelain')).split('\n')
      .filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))
    const skills = await skillsFromRoots([
      { dir: path.join(repoPath, '.agents/skills'), source: '.agents/skills', agents: ['pi'] },
      { dir: path.join(repoPath, '.pi/skills'), source: '.pi/skills', agents: ['pi'] },
      { dir: path.join(repoPath, '.claude/skills'), source: '.claude/skills', agents: ['claude'] },
    ])
    for (const skill of skills) skill.repo = repoPath
    const branch = (await git(repoPath, 'branch', '--show-current')).trim()
    repos.push({ name: path.basename(repoPath), path: repoPath, branch, lastCommitAt, worktrees, skills })
  })
  return repos.sort((a, b) => b.lastCommitAt.localeCompare(a.lastCommitAt))
}

// Project skills Pi wrote for itself through skill_manage, keyed by Pi's project name (the cwd's folder name).
export async function learnedProjectSkills() {
  const base = path.join(PI_DIR, 'projects-memory')
  const projects = await fs.readdir(base).catch(() => [])
  const learned = await Promise.all(projects.map(async (name) => ({
    name,
    skills: await skillsFromRoots([{ dir: path.join(base, name, 'skills'), source: `Pi, self-learned for ${name}`, agents: ['pi'] }]),
  })))
  return learned.filter((project) => project.skills.length > 0)
}

// The same skill reached through several roots (symlinks) becomes one entry with every location listed.
async function skillsFromRoots(roots: Root[]): Promise<Skill[]> {
  const byRealDir = new Map<string, Skill>()
  for (const root of roots) {
    for (const dir of await findSkillDirs(root.dir, 4)) {
      const realDir = await fs.realpath(dir)
      const skill = byRealDir.get(realDir) ?? await readSkill(realDir)
      // Nested skills keep their subfolder in the label, with long ids cut to 8 characters
      // (e.g. Claude.ai's synced/<bucket>/ folders).
      const nested = path.dirname(path.relative(root.dir, dir)).replace(/([0-9a-f]{8})[0-9a-f_-]{20,}/g, '$1')
      skill.locations.push({ path: dir, source: nested === '.' ? root.source : `${root.source} › ${nested}`, agents: root.agents })
      skill.agents = [...new Set([...skill.agents, ...root.agents])]
      byRealDir.set(realDir, skill)
    }
  }
  return [...byRealDir.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function findSkillDirs(dir: string, depth: number): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  if (entries.some((entry) => entry.name === 'SKILL.md')) return [dir]
  if (depth === 0) return []
  const children = entries.filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules' && (entry.isDirectory() || entry.isSymbolicLink()))
  return (await Promise.all(children.map((entry) => findSkillDirs(path.join(dir, entry.name), depth - 1)))).flat()
}

async function readSkill(realDir: string): Promise<Skill> {
  const text = await fs.readFile(path.join(realDir, 'SKILL.md'), 'utf8')
  const meta = parseFrontmatter(text)
  const files = await listFiles(realDir)
  return {
    id: realDir,
    name: meta.name || path.basename(realDir),
    description: meta.description ?? '',
    realDir,
    locations: [],
    agents: [],
    files,
    modifiedAt: files.reduce((latest, file) => (file.modifiedAt > latest ? file.modifiedAt : latest), ''),
  }
}

async function listFiles(root: string) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile() && !/(^|\/)(node_modules|\.git)(\/|$)/.test(entry.parentPath) && entry.name !== '.DS_Store')
  return Promise.all(files.map(async (entry) => {
    const full = path.join(entry.parentPath, entry.name)
    const stat = await fs.stat(full)
    return { rel: path.relative(root, full), size: stat.size, modifiedAt: stat.mtime.toISOString() }
  }))
}

// Covers the frontmatter skills use: plain, quoted, and folded (`>`/`|`) values.
export function parseFrontmatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const lines = block.split(/\r?\n/)
  const meta: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const match = /^([\w-]+):\s*(.*)$/.exec(lines[i])
    if (!match) continue
    let value = match[2].trim()
    if (value === '' || /^[>|][-+]?$/.test(value)) {
      const continued: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) continued.push(lines[++i].trim())
      value = continued.join(' ')
    }
    meta[match[1]] = value.replace(/^(["'])([\s\S]*)\1$/, '$2')
  }
  return meta
}

async function git(cwd: string, ...args: string[]) {
  return exec('git', ['-C', cwd, ...args]).then((result) => result.stdout, () => '')
}

async function readJson(file: string): Promise<any> {
  return fs.readFile(file, 'utf8').then(JSON.parse, () => undefined)
}

export async function eachLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) await run(items[next++])
  }))
}
