import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { parseFrontmatter, type Skill } from './skills.ts'
import { attribute, parseTranscript } from './usage.ts'

const line = (value: unknown) => JSON.stringify(value)

test('parseFrontmatter reads plain, quoted and folded values', () => {
  const meta = parseFrontmatter('---\nname: "luke-code"\ndescription: >\n  Write code\n  the way Luke likes.\nlicense: MIT\n---\n# body')
  assert.deepEqual(meta, { name: 'luke-code', description: 'Write code the way Luke likes.', license: 'MIT' })
})

test('Pi: SKILL.md reads and /skill commands count, skill text inside tool results does not', () => {
  const transcript = [
    line({ type: 'session', cwd: '/repo' }),
    line({ type: 'message', id: 'a1', timestamp: '2026-10-01T00:00:00Z', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 't1', name: 'read', arguments: { path: '.agents/skills/problem/SKILL.md' } },
      { type: 'toolCall', id: 't2', name: 'read', arguments: { path: '/repo/README.md' } },
    ] } }),
    line({ type: 'message', id: 'u1', timestamp: '2026-10-02T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: '<skill name="luke-voice" location="/x">' }] } }),
    line({ type: 'message', id: 'r1', timestamp: '2026-10-03T00:00:00Z', message: { role: 'toolResult', content: [{ type: 'text', text: '<skill name="luke-voice" location="/x">' }] } }),
  ].join('\n')

  const events = parseTranscript('pi', transcript)
  assert.deepEqual(events.map((event) => [event.kind, event.name, event.path]), [
    ['read', 'problem', '/repo/.agents/skills/problem/SKILL.md'],
    ['command', 'luke-voice', undefined],
  ])
})

test('Claude Code: Skill tool (plugin prefix dropped), slash commands and SKILL.md reads count', () => {
  const transcript = [
    line({ type: 'assistant', timestamp: '2026-10-01T00:00:00Z', cwd: '/repo', message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'code-review:code-review' } }] } }),
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-02T00:00:00Z', cwd: '/repo', message: { content: '<command-message>lucid-design</command-message>\n<command-name>/lucid-design</command-name>' } }),
    line({ type: 'assistant', timestamp: '2026-10-03T00:00:00Z', cwd: '/repo', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/home/.claude/skills/bro/SKILL.md' } }] } }),
  ].join('\n')

  assert.deepEqual(parseTranscript('claude', transcript).map((event) => [event.kind, event.name]), [
    ['skill-tool', 'code-review'],
    ['command', 'lucid-design'],
    ['read', 'bro'],
  ])
})

test('attribute maps worktree reads to the main checkout and keeps same-named repo skills apart', () => {
  const skill = (repo: string, name: string): Skill => {
    const dir = `${repo}/.agents/skills/${name}`
    return { id: dir, name, description: '', realDir: dir, repo, locations: [{ path: dir, source: '', agents: ['pi'] }], agents: ['pi'], files: [], modifiedAt: '' }
  }
  const automation = skill('/p/automation', 'problem')
  const wolfOps = skill('/p/wolf-ops', 'problem')
  const ship = skill('/p/wolf-ops', 'ship')
  const repos = [
    { path: '/p/automation', worktrees: ['/p/automation', '/p/dragon-123'] },
    { path: '/p/wolf-ops', worktrees: ['/p/wolf-ops', '/p/wolf-ops/.claude/worktrees/x'] },
  ]
  // A worktree folder git has pruned, still pointing at wolf-ops.
  const pruned = fs.mkdtempSync(path.join(os.tmpdir(), 'pruned-'))
  fs.writeFileSync(path.join(pruned, '.git'), 'gitdir: /p/wolf-ops/.git/worktrees/pruned\n')
  const at = '2026-10-01T00:00:00Z'
  const usage = attribute([
    { key: '1', agent: 'pi', kind: 'read', name: 'problem', path: '/p/dragon-123/.agents/skills/problem/SKILL.md', at },
    { key: '2', agent: 'pi', kind: 'command', name: 'problem', at, cwd: '/p/wolf-ops/.claude/worktrees/x/src' },
    // A live folder outside every repo can't load a repo skill.
    { key: '3', agent: 'pi', kind: 'command', name: 'problem', at, cwd: os.tmpdir() },
    { key: '4', agent: 'claude', kind: 'command', name: 'usage', at },
    // A deleted worktree in /p, where automation has 2 worktrees and wolf-ops 1.
    { key: '5', agent: 'pi', kind: 'read', name: 'problem', path: '/p/gone/.agents/skills/problem/SKILL.md', at, cwd: '/p/gone' },
    // Same deleted worktree, a name only wolf-ops has: the Skill tool proves the skill loaded, a slash
    // command could be a built-in or plugin command.
    { key: '6', agent: 'claude', kind: 'skill-tool', name: 'ship', at, cwd: '/p/gone' },
    { key: '7', agent: 'claude', kind: 'command', name: 'ship', at, cwd: '/p/gone' },
    { key: '8', agent: 'claude', kind: 'command', name: 'ship', at, cwd: pruned },
  ], [automation, wolfOps, ship], repos)

  assert.deepEqual(usage.get(automation)?.map((event) => event.key), ['1', '5'])
  assert.deepEqual(usage.get(wolfOps)?.map((event) => event.key), ['2'])
  assert.deepEqual(usage.get(ship)?.map((event) => event.key), ['6', '8'])
  assert.equal(usage.size, 3)
})
