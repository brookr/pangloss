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

Every run loops over four phases. Each agent works in its **own git worktree**
(isolated checkout + branch under `.pangloss/runs/<run>/round-<n>/worktrees/`).
Agents run **on the host** (not in containers), so each CLI uses its own existing
auth — this is why there's no credential injection anywhere.

1. **PLAN** ([src/phases/plan.ts](src/phases/plan.ts)) — N agents draft plans
   independently; a *rotating* synthesizer (`synth_rotation`) merges them into
   one canonical plan. Optional human approval gate (skipped with `--yes` /
   `--non-interactive`).
2. **CODE** ([src/phases/code.ts](src/phases/code.ts)) — each agent implements
   the plan in its worktree, runs the manifest's build/test commands, iterates to
   green (up to `max_code_iterations`), commits. node_modules is symlinked from
   the main checkout for speed.
3. **REVIEW** ([src/phases/review.ts](src/phases/review.ts)) — every agent
   reviews every implementation read-only (N×N matrix): score, novel ideas, gaps,
   still-needed. The worktree boundary is enforced as a read-only backstop.
4. **SELECT** ([src/phases/select.ts](src/phases/select.ts)) — weighted vote
   (self-reviews down-weighted 0.5), green-preferred; emits a **revision brief**
   (must-fix + novel ideas to graft from the also-rans + still-needed).

**Revise-loop** ([src/orchestrator.ts](src/orchestrator.ts)): if the winner
isn't converged (green + meets-criteria + empty must-fix/still-needed), re-base
every agent on the WINNING branch, turn the brief into a revision plan
(`runRevisionPlan`), and run the round again. Stops on convergence or
`max_rounds` (default 3).

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
├── validate.ts         # run manifest build/test, parse results
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
