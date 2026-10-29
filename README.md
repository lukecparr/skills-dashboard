# skills-dashboard

A local page for checking in on the agent skills on this machine: what's installed globally,
what lives in the repos you've committed to recently, what each skill's files say, and how
often Pi and Claude Code actually use them.

Everything is read from disk on each page load. Nothing is sent anywhere.

```bash
npm start          # http://127.0.0.1:4318 (PORT to change)
npm test
npm run check      # tsc
```

`RECENT_DAYS` (default 30) sets how far back "repos you committed to" looks. Needs Node 24
(it runs the TypeScript directly).

## Where skills come from

**Global**
- `~/.pi/agent/skills`, `~/.agents/skills` and Pi packages from `~/.pi/agent/settings.json`
  (their `pi.skills` entries, or `./skills`): Pi.
- `~/.pi/agent/pi-hermes-memory/skills`: skills Pi wrote itself with `skill_manage`.
- `~/.claude/skills` (including Claude.ai's `synced/<bucket>/` copies) and the skills of
  user-scope plugins enabled in `~/.claude/settings.json`: Claude Code.

A skill reached through several of these (symlinks) is shown once with every location.

**Repos.** Any git repo under `~/Projects`, `~/conductor/workspaces` or `~/.warp/worktrees`
with a commit by your `git config user.email` on any branch in the last `RECENT_DAYS`.
Worktrees are grouped under their repo. Skills are read from the main checkout's
`.agents/skills`, `.pi/skills` and `.claude/skills`.

**Pi self-learned project skills.** `~/.pi/agent/projects-memory/<project>/skills`.

## How usage is counted

From the session logs in `~/.pi/agent/sessions` and `~/.claude/projects`:
- **read:** the agent opened the skill's `SKILL.md` (how Pi loads a skill, and sometimes Claude Code).
- **skill-tool:** Claude Code's `Skill` tool.
- **command:** you ran `/skill:name` in Pi or `/name` in Claude Code.

A read is matched by the directory it read, with worktree paths mapped onto the repo's main
checkout. Everything else is matched by name. A repo skill only matches by name inside one of
its repo's worktrees. It also matches from a worktree that has since been deleted. For a pruned
worktree whose folder still exists, the repo is read from its `.git` file. Otherwise the guess is
the repo with the most worktrees in the same folder.

Limits:
- Only counts loads. It can't tell whether the agent then followed the skill.
- A skill whose description is already enough for the task may never be opened, so 0 uses
  doesn't always mean it's useless.
- Logs only go back as far as the agents keep them.
