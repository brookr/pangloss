# Pangloss v1 — Completion Plan

> *"All is for the best in this best of all possible worlds"* — Voltaire

This document describes the end-to-end workflow for Pangloss: an orchestrator that runs multiple AI coding agents in parallel, has them cross-evaluate each other's work, selects a winner, applies recommendations, and cleans up.

## Progress Checklist (living)

- [x] Plan authored (`plan-v1.md`)
- [x] Interactive planning UX (clarifying questions, iterative approval)
- [x] 4-phase pipeline wired (Generate → Judge → Finalize → Cleanup)
- [x] Playwright-capable agent container (`agent.Dockerfile`)
- [x] Per-phase results isolation under `.pangloss/runs/<run_id>/results/<mode>/<agent_preset>/`
- [x] Winner selection + recommendation consolidation
- [x] Non-winner branch cleanup + `--keep-branches`
- [x] Remove/disable unsupported Gemini defaults so a default run works
- [x] `npm run lint` passes cleanly
- [x] `npm test` passes cleanly
- [x] Judge mode is strictly read-only (detect/reset dirty tree after review)
- [x] Harden LLM invocation to avoid shell quoting issues
- [ ] End-to-end manual smoke test on a real repo

---

## 1. Execution Context & Assumptions

| Assumption | Detail |
|------------|--------|
| **Run location** | `pangloss` is executed from the root of an existing git repository. |
| **Remote detection** | Automatically detects `origin`; prompts if missing or non-GitHub. |
| **Branches only** | All checkouts use branches (no worktrees). |
| **Branch naming** | `pangloss/<run_id>/<agent_preset>` for candidates; `pangloss/<run_id>/final` for winner. |
| **run_id format** | `YYYYMMDD-HHmmss-<4-char-random>` (e.g., `20251213-003200-a1b2`). |
| **Cleanup default** | Non-winner branches are deleted after finalization unless `--keep-branches` is set. |

---

## 2. Milestone 1: Interactive Planning UX (Host-Side)

**Goal:** Before any Docker containers run, the user interactively defines and approves the Plan.

### 2.1 Flow

1. **Detect repo** — Confirm `.git` exists; read `origin` URL.
2. **Prompt for change** — "What change do you want to make?" (freeform input).
3. **Clarifying questions** — LLM generates 3-5 targeted questions based on the change request and repo structure (README, package.json, etc.).
4. **Collect answers** — User answers inline.
5. **Draft Plan** — LLM produces:
   - **Summary** (1-2 sentences)
   - **Scope** (files/areas affected)
   - **Steps** (ordered implementation steps)
   - **Acceptance Criteria** (testable conditions, including E2E)
6. **Iterate** — User can edit or request revisions.
7. **Approval gate** — Explicit `Approve plan? (y/n/edit)`.

### 2.2 Artifacts

| File | Purpose |
|------|---------|
| `.pangloss/runs/<run_id>/plan.md` | Human-readable Plan passed to all agents. |
| `.pangloss/runs/<run_id>/answers.json` | Structured Q&A for traceability. |
| `.pangloss/runs/<run_id>/run.json` | Metadata: run_id, agents, timestamps, config snapshot. |

### 2.3 Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `--planner-agent` | `claude-sonnet` | Preset used for interactive planning. |
| `--skip-planning` | `false` | Jump straight to generation (requires `--plan-file`). |
| `--plan-file` | — | Path to pre-approved Plan (skips interactive phase). |

---

## 3. Milestone 2: Orchestration Refactor

**Goal:** Replace the current single-phase "merge branches" approach with a 4-phase pipeline.

### 3.1 Phases

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   GENERATE   │ ──▶ │    JUDGE     │ ──▶ │   FINALIZE   │ ──▶ │   CLEANUP    │
│  (parallel)  │     │  (parallel)  │     │  (single)    │     │  (single)    │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

### 3.2 Per-Container Isolation

- Each agent runs in its own Docker container.
- Each container:
  - Clones the repo fresh.
  - Creates/checks out its own branch.
  - Runs the app, tests, Playwright locally inside the container.
  - Commits and pushes to remote.
- Host mounts a **unique results directory** per container:
  - Host: `.pangloss/runs/<run_id>/results/<agent_preset>/`
  - Container: `/results`
- Container writes:
  - `/results/result.json` — structured outcome
  - `/results/log.txt` — full execution log
  - `/results/judgements/*.json` — (judge mode only)

### 3.3 Orchestrator Responsibilities

- Generate `docker-compose.yml` with per-service volume mounts.
- Pass environment variables: `RUN_ID`, `AGENT_PRESET_ID`, `MODE`, `PLAN_CONTENT`, `CANDIDATE_BRANCHES` (judge mode), etc.
- Collect results by reading host directories.
- Aggregate judge scores and select winner.
- Invoke finalizer on winner branch.
- Delete non-winner remote branches (unless `--keep-branches`).

---

## 4. Milestone 3: Agent Runner (Inside Docker)

**Goal:** A single unified runner script (`agent-runner.js`) supporting three modes: `generate`, `judge`, `finalize`.

### 4.1 Modes

| Mode | Can modify repo? | Commits/pushes? | Purpose |
|------|------------------|-----------------|---------|
| `generate` | Yes | Yes | Implement the Plan on a new candidate branch. |
| `judge` | **No** | No | Evaluate candidate branches read-only; emit scores + recommendations. |
| `finalize` | Yes | Yes | Apply consolidated recommendations on winner branch; make final commit. |

### 4.2 Container Base Image

Switch from `node:20-alpine` to a Playwright-compatible image:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.40.0-jammy
```

This includes Chromium, Firefox, WebKit, plus glibc and common dependencies.

### 4.3 Iteration Loop (generate / finalize modes)

```
┌─────────────────────────────────────────────────────────┐
│ 1. Clone repo, checkout branch                          │
│ 2. Install deps, run baseline build + tests + E2E       │
│ 3. LOOP (max MAX_ITERATIONS):                           │
│    a. Invoke LLM CLI with Plan + current state          │
│    b. LLM writes code + tests (unit + Playwright E2E)   │
│    c. Run build + tests + E2E                           │
│    d. LLM writes .pangloss/state.json                   │
│       - done: boolean                                   │
│       - summary, remaining_work, risks                  │
│    e. IF done && validation passes → break              │
│    f. IF no diff for N iterations → break (safety)      │
│ 4. Commit + push branch                                 │
│ 5. Write /results/result.json                           │
└─────────────────────────────────────────────────────────┘
```

### 4.4 Safety Caps

| Cap | Default | Description |
|-----|---------|-------------|
| `MAX_ITERATIONS` | 5 | Hard limit on LLM invocations per run. |
| `ITERATION_TIMEOUT_MIN` | 10 | Timeout per single LLM invocation. |
| `TOTAL_TIMEOUT_MIN` | 60 | Timeout for entire generate/finalize phase. |
| `MAX_NO_DIFF_ITERATIONS` | 2 | Stop if no code changes for this many iterations. |

### 4.5 Test & E2E Expectations

- Agents **must** write/update unit tests covering new functionality.
- Agents **must** write Playwright E2E tests that verify the Plan's acceptance criteria.
- If Playwright is not present in the repo, agents install it and create initial scaffolding.

### 4.6 App Start Detection

Agents attempt to start the app for E2E testing using heuristics:

1. `package.json` → `npm run dev` / `npm start`
2. `docker-compose.yml` → `docker-compose up`
3. `Makefile` → `make run` / `make serve`
4. Environment variable `APP_START_CMD` override.

If detection fails, E2E tests run without an app server (Playwright may still work for static builds).

---

## 5. Milestone 4: Judging Phase

**Goal:** Each agent preset evaluates every candidate branch (including its own) and emits scores + recommendations.

### 5.1 Judge Workflow (per judge container)

```
┌─────────────────────────────────────────────────────────┐
│ 1. Clone repo                                           │
│ 2. Fetch all candidate branches                         │
│ 3. FOR each candidate branch:                           │
│    a. git checkout -B candidate origin/<branch>         │
│    b. Install deps, run build + tests + Playwright E2E  │
│    c. Generate diff summary vs base branch              │
│    d. Invoke LLM in "review mode" with:                 │
│       - Plan + acceptance criteria                      │
│       - Diff summary                                    │
│       - Test/build/E2E outputs                          │
│    e. LLM writes /results/judgements/<branch>.json      │
│    f. Verify working tree is clean; if dirty → reset    │
│       and mark judgement as "violation"                 │
│ 4. Write /results/result.json (aggregated summary)      │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Judgement Schema

```json
{
  "candidate_branch": "pangloss/20251213-003200-a1b2/codex-o3",
  "judge_preset": "claude-sonnet",
  "overall_score": 82,
  "sub_scores": {
    "correctness": 90,
    "completeness": 80,
    "code_quality": 85,
    "test_quality": 75,
    "maintainability": 80
  },
  "validation": {
    "build_passed": true,
    "unit_tests_passed": 45,
    "unit_tests_failed": 2,
    "e2e_tests_passed": 8,
    "e2e_tests_failed": 0
  },
  "recommendations": {
    "must_fix": [
      "Handle edge case when user is not authenticated"
    ],
    "nice_to_have": [
      "Extract duplicate validation logic into shared util"
    ]
  },
  "confidence": 0.85,
  "violation": false
}
```

### 5.3 Score Aggregation

- Collect all judgements.
- For each candidate, compute weighted average score:
  - Self-score weight: **0.5×**
  - Other-agent scores: **1.0×**
- Tie-breaker: prefer candidate with more passing E2E tests, then faster execution time.

### 5.4 Winner Eligibility

A candidate is only eligible to win if:
- Build passes.
- No failing unit tests (or fewer than baseline).
- E2E tests cover acceptance criteria (at least N E2E tests added, configurable).

---

## 6. Milestone 5: Finalization Phase

**Goal:** Apply consolidated recommendations to the winner branch, verify, and make a final commit.

### 6.1 Recommendation Consolidation

- Merge all `must_fix` items from all judges targeting the winner.
- Deduplicate by semantic similarity (simple: exact string match; advanced: LLM dedup).
- Order by frequency (more judges mentioning = higher priority).

### 6.2 Finalizer Workflow

- Spawn a finalizer container using the **same preset as the winner** (or `--finisher-agent` override).
- Mode: `finalize`.
- Prompt includes:
  - Original Plan
  - Consolidated recommendations
  - Instruction: "Apply must_fix items; skip nice_to_have unless trivial."
- Iterate until done (same loop as generate).
- Final commit message: `feat(<feature>): finalize per cross-agent review`
- Push to winner branch.

### 6.3 Final Validation Gate

Before declaring success:
- Build must pass.
- All unit tests must pass.
- All E2E tests must pass.

If validation fails after max iterations, mark run as **partial success** and leave branch for manual review.

---

## 7. Milestone 6: Cleanup Phase

**Goal:** Delete non-winner branches from remote.

### 7.1 Default Behavior

After finalization succeeds:
- Delete all `pangloss/<run_id>/<agent_preset>` branches except the winner.
- Rename winner branch to `pangloss/<run_id>/final` (optional; or keep original name).

### 7.2 CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--keep-branches` | `false` | Do not delete any branches. |
| `--dry-run` | `false` | Show what would be deleted without deleting. |

### 7.3 Safety

- Only delete branches matching `pangloss/<run_id>/*` created in this run.
- Never delete `main`, `master`, `develop`, or any branch not prefixed with `pangloss/`.

---

## 8. CLI Surface (Updated)

### 8.1 Commands

| Command | Description |
|---------|-------------|
| `pangloss` | Interactive planning + full pipeline (default). |
| `pangloss generate` | Same as above; accepts `--plan-file` to skip planning. |
| `pangloss judge --run-id <id>` | Re-run judging phase for an existing run. |
| `pangloss finalize --run-id <id>` | Re-run finalization for an existing run. |
| `pangloss cleanup --run-id <id>` | Manually trigger branch cleanup. |
| `pangloss setup` | Generate `.env` template. |
| `pangloss config` | Generate `pangloss.config.json`. |

### 8.2 Key Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--agents` | `codex-o3,claude-sonnet,gemini-pro` | Comma-separated agent presets. |
| `--planner-agent` | `claude-sonnet` | Preset for interactive planning. |
| `--finisher-agent` | (winner's preset) | Preset for finalization. |
| `--max-iterations` | `5` | Max LLM invocations per phase. |
| `--iteration-timeout` | `10` | Minutes per LLM invocation. |
| `--total-timeout` | `60` | Minutes per phase. |
| `--keep-branches` | `false` | Skip branch deletion. |
| `--dry-run` | `false` | Show actions without executing. |
| `--skip-planning` | `false` | Requires `--plan-file`. |
| `--plan-file` | — | Path to pre-approved Plan. |

---

## 9. Baseline Failure Policy

If the repo's existing tests or build fail **before** any agent makes changes:

1. Record baseline failures in `run.json`.
2. Allow agents to proceed.
3. Agents are expected to fix baseline failures if they block the Plan.
4. Winner eligibility: must have **fewer** failures than baseline (or zero).

---

## 10. Open Items / Future Enhancements

| Item | Status |
|------|--------|
| Gemini CLI support | Blocked until official CLI available; skip for v1. |
| Advanced merge strategies (`best_per_file`, `composite`) | Deferred; v1 uses winner-takes-all. |
| Parallel judging of multiple branches per container | Possible optimization; v1 is sequential per judge. |
| PR creation | Optional; add `--create-pr` flag. |
| Slack/webhook notifications | Future. |

---

## 11. File Structure (Post-Implementation)

```
pangloss/
├── src/
│   ├── cli.ts                  # CLI entry point
│   ├── planner.ts              # Interactive planning logic
│   ├── orchestrator.ts         # Phase orchestration (generate/judge/finalize/cleanup)
│   ├── docker-orchestrator.ts  # Docker compose generation + execution
│   ├── result-aggregator.ts    # Score aggregation + winner selection
│   ├── types.ts                # TypeScript interfaces
│   └── config.ts               # Configuration loading
├── agent-runner.js             # Unified runner (generate/judge/finalize modes)
├── agent.Dockerfile            # Playwright-based container image
├── pangloss.config.json        # Default presets
├── .env.example                # Environment template
├── package.json
├── tsconfig.json
└── README.md
```

---

## 12. Summary

Pangloss v1 delivers:

1. **Interactive planning** with user approval before any code generation.
2. **Parallel agent execution** in isolated Docker containers.
3. **Iterative implementation** with test-first development and Playwright E2E.
4. **Cross-agent judging** with quantified scores and actionable recommendations.
5. **Automated finalization** applying peer recommendations.
6. **Safe cleanup** of non-winner branches.

The system finds the *best of all possible solutions* by leveraging competition and collaboration between AI agents.
