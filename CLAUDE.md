# Pangloss Project Context

## What this is

**Pangloss** is a multi-model **fusion** code-generation system. It runs a
diverse roster of AI coding agents (different models *and* different agentic
harnesses) in parallel, has them cross-review each other's work, and synthesizes
the best result — a bespoke take on OpenRouter's "Fusion beats frontier" idea.
The thesis under test: a loop of sonnet-level + open-weight models can rival
frontier models, and combined frontier models dominate.

Named after Voltaire's Pangloss ("the best of all possible worlds").

## Architecture (current — worktree-based, Docker retired)

Each agent works in its **own git worktree** (isolated checkout + branch
`pangloss/<runId>/r<round>/<agentId>` under `.pangloss/runs/<run>/round-<n>/`).
Agents run **on the host** (not in containers), so each CLI uses its own existing
auth — this is why there's no credential injection anywhere. A run
([src/orchestrator.ts](src/orchestrator.ts)) executes in this order:

**Phase 0 — CONVENTIONS** ([src/phases/conventions.ts](src/phases/conventions.ts))
— before anything else, derive a project conventions guide (documented conventions
authoritative + git-history patterns observed) and cache it at
`.pangloss/conventions.md`. Stored on `ctx.conventions` (condensed for plan, full
for code/review) and injected into every later phase. No-op if nothing to learn.

**Phase 1 — PLAN** ([src/phases/plan.ts](src/phases/plan.ts)) — N agents draft
plans independently; a *rotating* synthesizer (`synth_rotation` / `pickSynthesizer`)
merges them into one canonical plan. Optional human approval gate (skipped with
`--yes` / `--non-interactive`).

**Acceptance gate (optional)** ([src/phases/acceptance.ts](src/phases/acceptance.ts))
— when `manifest.acceptanceCmd` is set, agents derive a canonical acceptance suite
from the plan; it's committed into a **new base every lane is cut from**, and impls
are graded against it. The suite must be **red on base** (a suite green on base is
vacuous → gate goes advisory, selection falls back to review). The post-gate base
is captured as `originBase` — the run's true origin — so the security audit later
sees the COMPLETE change. No-op when `acceptanceCmd` is unset.

**Round loop** (`max_rounds`, default 3) — each round:

1. **CODE** ([src/phases/code.ts](src/phases/code.ts)) — each agent implements the
   plan in its worktree, runs build/test, iterates to green (up to
   `max_code_iterations`), commits. node_modules is symlinked from the main checkout
   (real `pnpm install` for workspace monorepos). A lane-survival guard surfaces
   dropped lanes; the run aborts if survivors `< min_lanes`.
2. **REVIEW** ([src/phases/review.ts](src/phases/review.ts)) — every agent reviews
   every impl read-only (N×N): score, novel ideas, gaps, still-needed, acceptance-
   edit annotations. The worktree boundary is a read-only backstop.
3. **SELECT** ([src/phases/select.ts](src/phases/select.ts)) — weighted vote
   (self-reviews down-weighted 0.5), green-preferred; emits a **revision brief**
   (must-fix + ideas to graft from the also-rans + still-needed). With the gate on,
   "done" is objective: pass the FULL canonical suite without weakening it.
4. **REVISE** — if not converged, re-base every agent on the WINNING branch
   (`ctx.baseRef` tracks `roundBase`), turn the brief into a revision plan
   (`runRevisionPlan`), run the next round. Stops on convergence, a no-progress
   guard (`treesIdentical` to the prior winner), or `max_rounds`.

**Phase 5 — SECURITY AUDIT** ([src/phases/security.ts](src/phases/security.ts)) —
the final threshold, on the winner before cleanup. Every model audits the winner's
**full diff vs `originBase`** (line-boundary capped at `MAX_DIFF`; auditors are told
when it's truncated); a rotating synthesizer dedupes into one verdict. Passes with
no high/critical findings. **Fails CLOSED**: a systemic audit failure (0 usable
auditors) is treated as NOT-passed, and unrecognized severities escalate (never
silently sink to `low`). Pure, chalk-free helpers live in
[src/security-util.ts](src/security-util.ts) (`coerceFindings` / `coerceSeverity` /
`securityVerdict` / `highFindings` / `securityFixPlan`), unit-tested in
[__tests__/security.test.ts](__tests__/security.test.ts). No-op when
`security_audit: false` (bench sets this) or the winner has no diff.

**Auto-hardening** (`hardenWinner`, `max_security_rounds`, default 1) — on a failed
audit, `securityFixPlan` turns the high/critical findings into a deterministic
must-fix plan (no extra model call), then runs fix rounds *fusion-style*: re-base
every lane on the winner → CODE → REVIEW → SELECT → re-audit. Rounds use
`ctx.round = 100 + i` so dirs/branches never collide with the main loop; each round
diffs vs the prior winner (reviewers see only the fix) but re-audits vs `originBase`.
The prior winner's worktree stays live until a fix is **accepted** (a failed round
strands nothing). Stops on a clean audit or the cap. Set `max_security_rounds: 0`
to make the audit advisory.

## Roster / adapter model

The linchpin is [src/agents/adapter.ts](src/agents/adapter.ts) — a uniform
`AgentAdapter` over every CLI, with the verified non-interactive invocations:

| tool | invocation notes |
|---|---|
| `claude` | `claude -p --output-format text` (NOT json — json wraps the answer in a result envelope); `--permission-mode bypassPermissions` for code |
| `codex` | `codex exec -m … -s workspace-write/read-only --skip-git-repo-check`; prompt on stdin via `-` |
| `codex --oss` | adds `--oss --local-provider ollama` for local open-weight (e.g. `gpt-oss:120b`) |
| OpenRouter | codex with `-c model_provider=openrouter … wire_api="responses"` (codex dropped `"chat"`); needs `OPENROUTER_API_KEY`; reasoning capped to medium/low for frugality |
| `cursor` | `cursor-agent -p … --trust` (+`--force` for code). **Never `--mode ask/plan`** — those hang headless (never terminate) |
| `gemini` | `gemini -p -o text --approval-mode yolo/plan` |

Presets + named rosters live in [src/config.ts](src/config.ts) /
`pangloss.config.json`. Ad-hoc `<tool>:<model>` specs (`openrouter:…`, `cursor:…`,
`claude:…`, `oss:…`, `gemini:…`, `codex:…`) are resolved by `parseDynamicPreset`,
so any model can be dropped into `--roster` without editing config.

The shared agent behavior contract is
[.claude/skills/pangloss-worktree/SKILL.md](.claude/skills/pangloss-worktree/SKILL.md),
mirrored in compiled form at [src/agents/contract.ts](src/agents/contract.ts) and
injected into every agent's system prompt.

## File structure

```
src/
├── cli.ts              # run / agents / doctor / models / config / setup
├── orchestrator.ts     # the round loop + artifact persistence
├── context.ts          # RunContext assembled per run
├── config.ts           # presets, rosters, parseDynamicPreset, manifest defaults
├── types.ts            # all interfaces (live + legacy)
├── worktree.ts         # git worktree lifecycle + boundary enforcement
├── runtime.ts          # per-agent runtime: ComposeRuntime (isolated DB) or NoneRuntime
├── validate.ts         # run manifest build/test/e2e (with runtime env), parse results
├── agents/
│   ├── adapter.ts      # uniform CLI adapter (the linchpin)
│   └── contract.ts     # worktree contract + system-prompt composer
├── phases/{plan,code,review,select,prompts}.ts
└── util/{proc,pool,extract}.ts
```

`result-aggregator.ts` is legacy (kept only for its passing unit test).

## Dev commands

```bash
yarn build      # tsc
yarn test       # jest (ignores .pangloss/ worktrees)
yarn lint
yarn typecheck
node dist/cli.js doctor --roster <name>   # preflight a roster
```

## Status

- ✅ Full pipeline + revise-loop working end-to-end (validated by dogfood runs).
- ✅ Phase 5 security audit + auto-hardening validated live: a planted SQLi +
  command-injection + missing-authz winner is caught (FAILED), one hardening round
  remediates all three, re-audit flips to PASSED. Fail-closed/fail-safe paths and
  pure helpers covered in [__tests__/security.test.ts](__tests__/security.test.ts).
- ✅ All five harnesses validated live in runs: claude-code, cursor,
  codex→OpenRouter, gemini (needs `GOOGLE_CLOUD_PROJECT` — set in `.env`), and
  local `codex --oss` (gpt-oss:120b — functional but slow, ~19 min for a small
  task; give it a long `--local-timeout`).
- ⚠️ Free OpenRouter (`:free`) models are heavily rate-limited and unreliable for
  real coding — prefer paid slugs for dependable lanes.
- ⚠️ Worktrees are cut from the **last commit**; commit before a run if you want
  uncommitted work included.
- Default target manifest dogfoods Pangloss on itself (`yarn install/build/test`).
  Playwright/app/DB hooks exist in the manifest for web targets but aren't
  exercised by the dogfood target.

## Philosophy

Run many diverse agents in parallel, let them critique each other, and fuse the
best ideas — better outcomes than any single agent, with isolation (worktrees)
keeping every agent's changes contained.
