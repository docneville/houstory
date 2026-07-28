# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

No build step — static HTML/CSS/JS served as-is. `package.json` only holds
`pg`, used for occasional one-off Node scripts against Postgres.

```bash
npm install                # only needed for one-off db scripts
npx supabase db push       # apply migrations in supabase/migrations/
npx supabase functions deploy <name>  # deploy an edge function
python -m http.server 8080 # preview the static site locally
```

Auth for local testing uses email+password (not magic link, to avoid
depending on email-template/redirect-URL dashboard config) - Google
sign-in is planned for Phase 2 (houstory-96t.11) to replace this.

## Architecture Overview

Houstory is a photo-first app for tracking a home's history: renovations,
landscaping, paint colors, appliances, and the historical photos behind them.

- **Frontend**: plain static HTML/CSS/JS pages, no framework or bundler
  (mirrors [five-wonders](https://github.com/docneville/five-wonders)).
- **Backend**: Supabase (Postgres + Storage + Edge Functions). Schema lives
  in `supabase/migrations/*.sql`, applied in order. Server logic lives in
  `supabase/functions/<name>/`.
- **AI**: Claude is used to describe and categorize uploaded photos
  (renovation vs. landscaping vs. appliance, etc.) — planned as an Edge
  Function that calls the Claude API on upload.
- **Hosting**: GitHub Pages, custom domain via the root `CNAME` file.

## Conventions & Patterns

- No local `supabase/config.toml` — project is linked via `npx supabase link`
  (state cached in the gitignored `supabase/.temp/`).
- Migrations are numbered sequentially (`001_...sql`, `002_...sql`, ...).
- Use `bd` for all task tracking (see above) — file issues for schema/feature
  work rather than building it ad hoc.
