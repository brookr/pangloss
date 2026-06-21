# Pangloss — Roadmap to a Complete Web-App Feature-Dev Loop

**Goal:** Pangloss is a complete **plan → write → review** loop for **web app feature
development** — diverse agents plan, implement in isolated worktrees, cross-review,
select, revise, and pass an objective gate, for real web-app features (UI + API + DB
+ tests), not just refactors or single-file fixes.

This file is the working roadmap. It is self-contained so a fresh session can execute
it cold. Update it as tasks land.

## Where we are (works, validated)

- Phase 0 conventions → Plan → (Acceptance gate) → Code → Review → Select → Revise →
  Phase 5 Security audit + auto-hardening. All green end-to-end.
- Acceptance gate: JS/TS unit-level + SWE-bench-in-Docker (the acc-docker harness bugs
  are fixed — see `bench/swe/acc-docker.mjs`).
- **Full-stack milestone (2026-06-21):** ran the full loop on the real MSI app
  (`~/projects/msi/technician-app-gamma`, pnpm/turbo Next.js monorepo) for the
  `indexDocument.ts` batched-upsert task. Winner cursor-claude-4.5-sonnet, security
  audit PASSED. Validated in-loop on `types:check` + unit tests; the winner's batched
  `ensureDocumentModelLinks` then verified against an **isolated gamma Postgres** —
  full db-tests integration suite **38/38 green**. Config: `msi-gamma-fullstack.config.json`.

## The gaps (what's missing for the goal) — prioritized

### 1. Worktree env/file provisioning  ← DO FIRST (pure, safe, unblocks everything)
Web apps need gitignored files (e.g. `apps/agent-supervisor-chat/.env.local`) present
in each worktree to build/test/e2e. Worktrees are cut from a commit, so gitignored
files are absent. Add a manifest field, e.g.:
```
manifest.provision?: string[]   // repo-relative paths to copy from the main checkout
                                 // into each worktree before `setup` runs
```
Implement in `src/phases/code.ts` `prepareDeps` (or a new `provisionFiles` step called
first in `runOneAgent`). Copy each path from `ctx.repoRoot` into `wt.path` (mkdir -p
parent; skip if missing, log). Add `provision?: string[]` to `TargetManifest` in
`src/types.ts`. Unit-test the copy logic (chalk-free helper). This is THE blocker for
real web-app validation in the loop.

### 2. Compose runtime + DB-integration as an IN-LOOP gate (gamma)
ComposeRuntime (`src/runtime.ts`) exists but has never been exercised in a real run.
Wire `manifest.compose` to gamma's `docker-compose.yml`, `dbSetup` = drizzle migrate,
`urlEnv: DATABASE_URL`, `dbPortBase` on a **unique** range (NOT 5432). Use the db-tests
integration suite as the test/acceptance gate. Friction to solve generally:
  - The app's db-tests guard hardcodes `:5432` (`packages/db-tests/src/globalSetup.ts`
    regex `@[^:]+:5432/test_db`). ComposeRuntime injects a remapped port, which the
    guard rejects. Options: (a) provision a port-relaxed copy of globalSetup via the
    task-1 `provision` mechanism; (b) add a ComposeConfig escape so the URL the guard
    sees matches; (c) document a per-app shim. Keep it general where possible.
  - **SAFETY (critical):** `technician-app-bravo-db-1` owns host port **5432** and is
    the user's ACTIVE work. The guard only checks `test_user/test_password/test_db`,
    which bravo ALSO matches — so a misrouted DATABASE_URL would run destructive
    fixture-resets against bravo. NEVER bind 5432; ALWAYS assert DATABASE_URL is the
    isolated unique port before any destructive test. Verified-safe pattern from the
    last session: rewrite compose port 5432→5455+, unique project name, migrate, run.

### 3. Capstone: a real user-facing feature end-to-end on gamma
Plan→write→review→select→revise→security on a genuine UI+API+DB feature (not a
refactor). The proof of the goal. Stretch: Playwright e2e (`packages/.../e2e-tests`,
`playwright.config.ts`) as an in-loop gate — needs the built app + dev server + DB +
Clerk auth; heavy, lowest priority.

## Hard constraints (always)
- **Only touch `~/projects/msi/technician-app-gamma`.** Never bravo or delta. Don't
  commit to gamma's `main` — work lives in worktree branches.
- **Don't spend OpenRouter credit.** Rosters: Claude subs (`claude:sonnet|haiku|opus`),
  Cursor sub (`cursor:...`), local LM Studio/Ollama (`lmstudio:`/`oss:`) only.
- **`.env*` holds live secrets** — keep them out of output/logs; never commit them.
- Pangloss work lands on branch `feat/fusion-multi-model`; commit + (when green)
  ff `main` and push, per the established flow.

## Suggested order for the next autonomous session
1. Task 1 (provisioning) — implement + tests + build/lint/typecheck green + commit/push.
2. Task 2 (compose+DB in-loop) — wire config, run on gamma with isolated DB, prove the
   DB-integration gate drives selection. Commit/push the runtime/config changes.
3. Task 3 (capstone feature) — if time, run a real feature end-to-end.
Report progress concisely; leave this file updated.
