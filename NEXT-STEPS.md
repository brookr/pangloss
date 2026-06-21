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
- **✅ Task 1 — worktree provisioning (DONE, `08e6c71`):** `manifest.provision: string[]`
  copies gitignored files into each worktree before setup. `src/provision.ts` (chalk-free,
  path-safe, unit-tested).
- **✅ Task 2 — DB-integration as an IN-LOOP gate (DONE):** ran a real DB-gated fusion on
  gamma — ComposeRuntime brought up isolated per-lane Postgres (5460/5461, never 5432),
  drizzle-migrate via `dbSetup`, and the db-tests integration suite ran **38/38 per lane
  as the selection gate**. Winner diff stayed clean (the `:5432` test guard is relaxed +
  `skip-worktree`d by `scripts/relax-db-port-guard.mjs`, never committed). Config:
  `msi-gamma-db.config.json`. ComposeRuntime needed no code changes — it works as built.

## The gaps (what's missing for the goal) — prioritized

### ~~1. Worktree env/file provisioning~~ — DONE (see above)
### ~~2. Compose runtime + DB-integration as an in-loop gate~~ — DONE (see above)
Reusable pattern for an app whose tests hardcode the DB port: ComposeRuntime publishes
the per-lane DB on a unique host port and injects `DATABASE_URL`; the app's port-pinned
test guard is widened (port-only, identity check kept) and `skip-worktree`d via
`scripts/relax-db-port-guard.mjs` in `compose.dbSetup`. SAFETY: never bind 5432; the
injected URL is the only DB the tests reach — assert the isolated port before destructive
tests. (On a clean CI box with no competing stack, the DB can just use its native port.)

### 3. Capstone: a real user-facing feature end-to-end on gamma  ← NEEDS USER INPUT
Plan→write→review→select→revise→security on a genuine feature. This is the one
remaining dimension: every gamma run so far has been a behavior-preserving REFACTOR
(indexDocument batching). Two reasons this needs the user to choose the feature:
  - **No clean candidate exists in-repo.** Only TODO left is `scheduler.ts:247`
    (phase-3 cron sharding + bounded concurrency) — large, touches core control flow,
    and has no existing test to gate on. Inventing a feature would be make-work in the
    user's real app.
  - **A refactor can't exercise the acceptance gate.** The spec-derived gate requires
    NET-NEW behavior (must be red-on-base). A behavior-preserving change is green on
    base → gate goes advisory. So proving the *objective acceptance gate for web
    features* specifically needs a net-new feature with testable acceptance criteria.

Good capstone shapes (pick one): a small net-new API/query + its db-test (DB-gated,
low risk, no UI); a net-new UI+API+DB feature (needs the acceptance gate or e2e to
gate the UI); or the `scheduler.ts` sharding refactor (write the missing scale test
first, then gate on it). Stretch for any: Playwright e2e (`packages/.../e2e-tests`,
`playwright.config.ts`) as an in-loop gate — needs built app + dev server + DB + Clerk
auth; heavy, lowest priority.

When running the acceptance gate on gamma, reuse the `msi-gamma-db.config.json` compose
block and set `manifest.acceptanceCmd` to a runner that executes the `acceptance/` dir
against the injected isolated `DATABASE_URL` (those tests are separate from the app's
`packages/db-tests`, so they sidestep its port guard entirely).

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
