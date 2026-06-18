# SWE-bench Lite — does fusion beat solo? (honest findings)

**TL;DR.** On a 9-task hidden-grader subset, the Pangloss fusion pipeline scored
**exactly the same as the best solo lane (1/9)** — and for a precise, measurable
reason: the lanes had **zero complementarity** (every model solved the same one
task and failed the same eight), so even a *perfect* selector (the oracle) could
not exceed a single lane. Where lanes *did* differ, the cross-model review
scores were **not correlated with hidden-test correctness** (the strongest lane,
`claude-sonnet`, won **0 of 9** review votes). This matches the earlier polyglot
result: **fusion's lift is real only when (a) lanes are complementary AND (b) the
loop has a trustworthy validation signal.** This subset had neither.

## Method

- **Tasks:** 9 SWE-bench Lite instances — `pallets/flask` ×3, `psf/requests` ×6
  (chosen for small gold diffs; see `bench/swe/tasks.json`).
- **Hidden grader:** agents see only the GitHub issue text. They never see the
  `FAIL_TO_PASS` tests. Scoring uses the **official `swebench` Docker harness**
  (`princeton-nlp/SWE-bench_Lite`). No grading test is ever placed in a worktree.
- **Generation** (`bench/swebench.mjs`): clone @ `base_commit`, fix the issue,
  capture the source-only diff (test files excluded from the patch) as the
  prediction.
  - `solo` — one agent edits the repo directly (`claude -p`, code mode).
  - `diverse` — full pipeline: plan → synth → code (N lanes) → N×N review →
    weighted select. **No test signal** (`manifest.test=''`) — the same blind
    condition as solo, so the only difference is the fusion loop. `--rounds 1`.

## Results (official Docker scoring)

| config | signal | resolved |
|---|---|---|
| solo `claude:sonnet` | none | **1/9** (`requests-3362`) |
| solo `claude:haiku` | none | **0/9** |
| fusion `claude:sonnet,haiku,sonnet@b` (r1) | none | **1/9** (`requests-3362`) |
| fusion `claude:sonnet,haiku,cursor:kimi-k2.5` (r1) | none | **1/9** (`requests-3362`) |
| — lane `claude-sonnet` (inside the kimi fusion) | — | 1/9 |
| — lane `claude-haiku` | — | 1/9 |
| — lane `cursor-kimi-k2.5` | — | 1/9 |
| **ORACLE** (any lane solves it) | — | **1/9** |

Every configuration resolves **exactly `psf__requests-3362` and nothing else.**

## Why fusion didn't help here

1. **Zero complementarity (the dominant factor).** All three lanes — two model
   families (Anthropic, Moonshot), three harnesses (claude-code, cursor-agent) —
   succeed and fail on the *identical* tasks. The oracle (union of any lane
   succeeding) = 1/9 = each individual lane. Fusion can only add value when
   different lanes solve different tasks; here there was nothing to select
   *toward*. The "selection gap" (a lane solved it, select picked wrong) was
   **empty**.

2. **Review scores ≠ correctness.** Where lanes produced different patches, the
   cross-model review (which drives selection with no test signal) mis-ranked
   them. In the kimi fusion, by review score `claude-haiku` won 6/9 and
   `cursor-kimi` 3/9 — **`claude-sonnet` won 0/9**, despite being the only lane
   that solves anything solo. In the all-Claude fusion, select even picked a
   *worse* patch than solo on `requests-2317` (0/8 vs 4/8 FAIL_TO_PASS flipped).
   With no ground truth, review rewards plausible/well-presented diffs, not
   correct ones.

3. **The failure modes are the hard kind.** Per-test analysis of the 8 misses:
   - **Unstated adjacent requirements** — `flask-4045` needs *two* fixes
     (blueprint-name dot check **and** `add_url_rule` endpoint-dot check); the
     issue only describes the first. Every lane (and the synthesized plan) fixed
     the stated half and converged "✓ meets, 94.6/100." No agent can divine a
     requirement that exists only in the hidden test.
   - **Regressions** — the `requests` patches broke 9–23 previously-passing
     tests each (the agents edit without running the existing suite). A blind
     review didn't reliably prefer the minimal, non-regressing diff.

## Consistency with the polyglot experiment

The earlier Aider-polyglot run showed fusion at ~95% **only when the grading
tests were visible** in the worktree (the loop optimized the grader). With a
**hidden** grader, fusion's lift collapsed to ≈ solo. SWE-bench (hidden by
design) reproduces that: **the lever is a trustworthy validation signal, not
diversity per se.**

## Caveats (don't over-generalize)

- **Small, hard, correlated subset.** 9 tasks, all from 2 repos, all uniformly
  hard for this harness (1/9). Complementarity can only appear where individual
  lanes score in a middle band (~30–60%) and disagree on *which* tasks they
  solve. At the floor there is no spread to exploit.
- **Weak per-lane harness.** Solo is a near-one-shot `claude -p`, not a
  purpose-built SWE agent (localize → patch → run tests → iterate). Published
  Claude SWE-bench Lite numbers (~50%+) use heavier scaffolding; 1/9 here
  reflects the thin harness + the hard subset, not the model's ceiling.

## What would actually test the hypothesis

1. **Broader sample for complementarity** (Claude-only, zero metered cost):
   30–50 SWE-bench Lite tasks across many repos, score each lane individually,
   and measure **oracle − best-single-lane**. If the oracle materially exceeds
   the best lane, diversity *is* generating complementary fixes and the problem
   reduces to selection.
2. **Give the loop a real signal** (the proven lever): have each lane write a
   reproduction test from the issue and run the repo's existing suite as a
   regression guard, so `code` iterates to green and `select` is green-preferred
   — *without* leaking the hidden `FAIL_TO_PASS` grader.

## Reproduce

```bash
node bench/swebench.mjs --mode solo    --model claude:sonnet --instances all --run-id sonnet9
node bench/swebench.mjs --mode diverse --model "claude:sonnet,claude:haiku,cursor:kimi-k2.5" --instances all --run-id divkimi9
python3 -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path bench/swe/preds-<run>.jsonl --run_id <run> --max_workers 4
# per-lane candidates land in bench/swe/cands-<run>.jsonl (oracle analysis)
```
