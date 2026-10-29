import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eachLimit, type Agent, type Skill } from './skills.ts'

const HOME = os.homedir()
const SOURCES: { agent: Agent; dir: string }[] = [
  { agent: 'pi', dir: path.join(HOME, '.pi/agent/sessions') },
  { agent: 'claude', dir: path.join(HOME, '.claude/projects') },
]

// read: the agent opened SKILL.md itself. skill-tool: Claude Code's Skill tool. command: the user ran /name or /skill:name.
export type UseEvent = { key: string; agent: Agent; kind: 'read' | 'skill-tool' | 'command'; name: string; path?: string; at: string; cwd?: string }

const fileCache = new Map<string, { stamp: string; events: UseEvent[] }>()

// Re-parses only transcripts whose size or mtime changed since the last scan.
export async function scanUsage() {
  const started = Date.now()
  const files: { agent: Agent; file: string }[] = []
  for (const source of SOURCES) {
    const entries = await fs.readdir(source.dir, { recursive: true }).catch(() => [])
    for (const rel of entries) if (rel.endsWith('.jsonl')) files.push({ agent: source.agent, file: path.join(source.dir, rel) })
  }

  const events = new Map<string, UseEvent>()
  await eachLimit(files, 8, async ({ agent, file }) => {
    const stat = await fs.stat(file)
    const stamp = `${stat.size}:${stat.mtimeMs}`
    let cached = fileCache.get(file)
    if (cached?.stamp !== stamp) {
      cached = { stamp, events: parseTranscript(agent, await fs.readFile(file, 'utf8')) }
      fileCache.set(file, cached)
    }
    // Resumed and forked sessions copy earlier lines into a new file, so the same call can appear twice.
    for (const event of cached.events) events.set(event.key, event)
  })
  return { events: [...events.values()], files: files.length, ms: Date.now() - started }
}

export function parseTranscript(agent: Agent, text: string): UseEvent[] {
  const events: UseEvent[] = []
  let cwd: string | undefined
  for (const line of text.split('\n')) {
    if (agent === 'pi' && line.startsWith('{"type":"session"')) cwd = JSON.parse(line).cwd
    if (!/SKILL\.md|<skill name=|"name":"Skill"|<command-name>/.test(line)) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    events.push(...(agent === 'pi' ? piEvents(entry, cwd) : claudeEvents(entry)))
  }
  return events
}

function piEvents(entry: any, cwd: string | undefined): UseEvent[] {
  const message = entry.type === 'message' ? entry.message : undefined
  if (!Array.isArray(message?.content)) return []
  const at = entry.timestamp
  if (message.role === 'assistant') {
    return message.content
      .filter((block: any) => block.type === 'toolCall' && block.name === 'read' && /(^|\/)SKILL\.md$/.test(block.arguments?.path ?? ''))
      .map((block: any) => readEvent(block.id, 'pi', block.arguments.path, at, cwd))
  }
  if (message.role === 'user') {
    const name = /^<skill name="([^"]+)"/.exec(message.content[0]?.text ?? '')?.[1]
    if (name) return [{ key: `pi:${entry.id}:${at}`, agent: 'pi', kind: 'command', name, at, cwd }]
  }
  return []
}

function claudeEvents(entry: any): UseEvent[] {
  const { message, timestamp: at, cwd } = entry
  if (entry.type === 'assistant' && Array.isArray(message?.content)) {
    return message.content.flatMap((block: any): UseEvent[] => {
      if (block.type !== 'tool_use') return []
      if (block.name === 'Skill' && block.input?.skill) {
        // Plugin skills are invoked as `plugin:skill`.
        return [{ key: block.id, agent: 'claude', kind: 'skill-tool', name: block.input.skill.split(':').pop(), at, cwd }]
      }
      if (block.name === 'Read' && /(^|\/)SKILL\.md$/.test(block.input?.file_path ?? '')) return [readEvent(block.id, 'claude', block.input.file_path, at, cwd)]
      return []
    })
  }
  // Slash commands arrive as a plain-string user message. Built-ins like /usage also land here and
  // simply never match a skill.
  const command = entry.type === 'user' && typeof message?.content === 'string' && /<command-name>\/([^<\s]+)<\/command-name>/.exec(message.content)?.[1]
  if (command) return [{ key: entry.uuid, agent: 'claude', kind: 'command', name: command.split(':').pop()!, at, cwd }]
  return []
}

function readEvent(key: string, agent: Agent, file: string, at: string, cwd: string | undefined): UseEvent {
  const absolute = path.resolve(cwd ?? HOME, file.replace(/^~(?=\/)/, HOME))
  return { key, agent, kind: 'read', name: path.basename(path.dirname(absolute)), path: absolute, at, cwd }
}

// Ties an event to one skill: by the directory it read, mapping a worktree path onto the repo's main
// checkout, then by name. By name, a repo skill matches only inside one of its repo's worktrees, or
// from a worktree that has since been deleted.
export function attribute(events: UseEvent[], skills: Skill[], repos: { path: string; worktrees: string[] }[]) {
  const byDir = new Map<string, Skill>()
  for (const skill of skills) for (const dir of [skill.realDir, ...skill.locations.map((location) => location.path)]) byDir.set(dir, skill)
  // Longest first, so a worktree nested inside another checkout wins.
  const checkouts = repos.flatMap((repo) => repo.worktrees.map((worktree) => ({ worktree, repo: repo.path })))
    .sort((a, b) => b.worktree.length - a.worktree.length)
  const checkoutOf = (dir = '') => checkouts.find((checkout) => dir === checkout.worktree || dir.startsWith(checkout.worktree + '/'))

  const usage = new Map<Skill, UseEvent[]>()
  for (const event of events) {
    let skill: Skill | undefined
    if (event.path) {
      const dir = path.dirname(event.path)
      const checkout = checkoutOf(dir)
      skill = byDir.get(dir) ?? (checkout && byDir.get(checkout.repo + dir.slice(checkout.worktree.length)))
    }
    if (!skill) {
      const live = checkoutOf(event.cwd)?.repo ?? (event.cwd && prunedWorktreeRepo(event.cwd))
      // A deleted cwd is usually a removed worktree, whose repo can only be guessed. Claude slash
      // commands also cover built-ins and plugin commands, so they need the guessed repo to own the
      // name; anything else proves a skill loaded, so any repo's copy will do.
      const deleted = !live && event.cwd !== undefined && !existsSync(event.cwd)
      const guess = deleted ? likelyRepo(event.cwd!, repos) : undefined
      const loose = deleted && !(event.agent === 'claude' && event.kind === 'command')
      skill = skills
        .filter((s) => (s.name === event.name || path.basename(s.realDir) === event.name) && (!s.repo || s.repo === (live ?? guess) || loose))
        .sort((a, b) => Number(b.repo === guess) - Number(a.repo === guess) || Number(b.agents.includes(event.agent)) - Number(a.agents.includes(event.agent)))[0]
    }
    if (skill) usage.set(skill, [...(usage.get(skill) ?? []), event])
  }
  return usage
}

// A worktree git has pruned still names its repo in its .git file: `gitdir: <repo>/.git/worktrees/<name>`.
function prunedWorktreeRepo(dir: string) {
  try {
    return /^gitdir: (.+)\/\.git\/worktrees\//.exec(readFileSync(path.join(dir, '.git'), 'utf8'))?.[1]
  } catch {
    return undefined
  }
}

// The repo with the most live worktrees in the same folder (automation's task worktrees all sit side by side).
function likelyRepo(cwd: string, repos: { path: string; worktrees: string[] }[]) {
  const parent = path.dirname(cwd)
  const scored = repos.map((repo) => ({ repo: repo.path, count: repo.worktrees.filter((worktree) => path.dirname(worktree) === parent).length }))
  return scored.filter((s) => s.count > 0).sort((a, b) => b.count - a.count)[0]?.repo
}
