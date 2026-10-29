import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { globalSkills, learnedProjectSkills, recentRepos, type Skill } from './skills.ts'
import { attribute, scanUsage, type UseEvent } from './usage.ts'

const PORT = Number(process.env.PORT ?? 4318)
const RECENT_DAYS = Number(process.env.RECENT_DAYS ?? 30)
const DAY = 86_400_000
const INDEX = new URL('../web/index.html', import.meta.url)

// Every skill directory from the last scan. /api/file only serves files inside one of these.
let knownDirs: string[] = []

async function dashboard() {
  const [global, repos, learned, usage] = await Promise.all([globalSkills(), recentRepos(RECENT_DAYS), learnedProjectSkills(), scanUsage()])
  const all: Skill[] = [...global, ...repos.flatMap((repo) => repo.skills), ...learned.flatMap((project) => project.skills)]
  knownDirs = all.map((skill) => skill.realDir)

  const used = attribute(usage.events, all, repos)
  const withUsage = (skill: Skill) => ({ ...skill, usage: summarize(used.get(skill) ?? []) })
  return {
    generatedAt: new Date().toISOString(),
    recentDays: RECENT_DAYS,
    scan: { transcripts: usage.files, events: usage.events.length, ms: usage.ms },
    global: global.map(withUsage),
    repos: repos.map((repo) => ({ ...repo, skills: repo.skills.map(withUsage) })),
    learned: learned.map((project) => ({ ...project, skills: project.skills.map(withUsage) })),
  }
}

function summarize(events: UseEvent[]) {
  const now = Date.now()
  const sorted = events.toSorted((a, b) => b.at.localeCompare(a.at))
  const within = (days: number) => sorted.filter((event) => now - Date.parse(event.at) < days * DAY).length
  // Use counts for each of the last 12 weeks, oldest first.
  const weeks = Array.from({ length: 12 }, (_, i) => sorted.filter((event) => {
    const age = now - Date.parse(event.at)
    return age >= (11 - i) * 7 * DAY && age < (12 - i) * 7 * DAY
  }).length)
  return {
    total: sorted.length,
    last7: within(7),
    last30: within(30),
    lastUsedAt: sorted[0]?.at,
    pi: sorted.filter((event) => event.agent === 'pi').length,
    claude: sorted.filter((event) => event.agent === 'claude').length,
    weeks,
    recent: sorted.slice(0, 25),
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  try {
    if (url.pathname === '/') return send(res, 200, 'text/html', await fs.readFile(INDEX))
    if (url.pathname === '/api/data') return send(res, 200, 'application/json', JSON.stringify(await dashboard()))
    if (url.pathname === '/api/file') {
      const file = await fs.realpath(url.searchParams.get('path') ?? '')
      if (!knownDirs.some((dir) => file.startsWith(dir + path.sep))) return send(res, 403, 'text/plain', 'Not inside a known skill directory')
      if ((await fs.stat(file)).size > 1_000_000) return send(res, 413, 'text/plain', 'File is over 1 MB')
      return send(res, 200, 'text/plain; charset=utf-8', await fs.readFile(file))
    }
    send(res, 404, 'text/plain', 'Not found')
  } catch (error) {
    send(res, 500, 'text/plain', String((error as Error).stack ?? error))
  }
})

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

server.listen(PORT, '127.0.0.1', () => console.log(`Skills dashboard on http://127.0.0.1:${PORT}`))
