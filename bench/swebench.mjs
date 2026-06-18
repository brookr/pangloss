#!/usr/bin/env node
// SWE-bench Lite generation runner for Pangloss.
//
// For each task: clone the repo @ base_commit, have Pangloss fix the issue
// (problem_statement) WITHOUT ever seeing the hidden FAIL_TO_PASS tests, and
// capture the winner's diff as the prediction. Score separately with the
// official harness:
//   python3 -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite \
//     --predictions_path bench/swe/preds-<run>.jsonl --run_id <run> --max_workers 4
//
// Modes:
//   solo    — one agent edits the repo directly (the control)
//   diverse — full Pangloss pipeline (comma roster), winner's patch
//
//   node bench/swebench.mjs --mode solo    --model claude:sonnet --instances all --run-id solo1
//   node bench/swebench.mjs --mode diverse --model "claude:sonnet,claude:haiku,oss:gpt-oss:120b" --run-id div1

import 'dotenv/config';
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, existsSync, mkdirSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentAdapter } from '../dist/agents/adapter.js';
import { getDefaultConfig, parseDynamicPreset } from '../dist/config.js';
import { executeRun } from '../dist/orchestrator.js';
import { mapPool } from '../dist/util/pool.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SWE = join(HERE, 'swe');
const REPOS = join(SWE, 'repos');

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
}
const MODE = arg('mode', 'diverse');
const MODEL = arg('model', 'claude:sonnet');
const RUN = arg('run-id', 'pang');
const INSTANCES = arg('instances', 'all');
const TIMEOUT = parseInt(arg('timeout', '15'), 10);
const CONC = parseInt(arg('concurrency', '2'), 10);
const ROUNDS = parseInt(arg('rounds', '1'), 10); // fusion rounds (1 = single round; >1 enables the revise loop)

const tasks = JSON.parse(readFileSync(join(SWE, 'tasks.json'), 'utf8')).filter(
  (t) => INSTANCES === 'all' || INSTANCES.split(',').includes(t.instance_id)
);

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...opts }).toString();

// In diverse mode, record every lane's candidate patch (recovered from its kept
// git branch) so we can later tell "no lane found the fix" from "select picked
// the wrong lane." Keyed by instance_id; written to a cands-<run>.jsonl sidecar.
const candidatesByInstance = {};

function repoClone(repo) {
  const dir = join(REPOS, repo.replace('/', '__'));
  if (!existsSync(dir)) {
    mkdirSync(REPOS, { recursive: true });
    process.stderr.write(`cloning ${repo}…\n`);
    sh(`git clone --quiet https://github.com/${repo} "${dir}"`);
  }
  return dir;
}

function setupWork(task) {
  const cache = repoClone(task.repo);
  const work = mkdtempSync(join(tmpdir(), 'swe-'));
  sh(`git clone --quiet "${cache}" "${work}"`);
  sh(`git -C "${work}" checkout --quiet ${task.base_commit}`);
  // ANSWER-LEAK GUARD: the cache is a full mirror, so every FUTURE commit (the
  // actual fix + its tests) is reachable via `git log --all` / `git show`. Drop
  // the .git mirror entirely and re-init a single-commit snapshot AT base_commit
  // so no future history is reachable. Agents must solve from the code, not the
  // repo's future.
  rmSync(join(work, '.git'), { recursive: true, force: true });
  appendFileSync(join(work, '.gitignore'), '\n.pangloss/\nswe.config.json\n');
  sh(`git -C "${work}" init -q`);
  sh(`git -C "${work}" add -A`);
  sh(`git -C "${work}" -c user.email=b@b.co -c user.name=bench commit -q -m base --no-verify`);
  const baseRef = sh(`git -C "${work}" rev-parse HEAD`).trim();
  return { work, baseRef };
}

// Exclude our control files AND any test files: the prediction must be
// source-only (the grader supplies its own tests), and agents are encouraged to
// write throwaway scratch tests to verify — those must not pollute the patch.
const PATCH_EXCLUDES = [
  '":(exclude).pangloss"', '":(exclude).gitignore"', '":(exclude)swe.config.json"',
  '":(exclude,glob)**/tests/**"', '":(exclude,glob)tests/**"',
  '":(exclude,glob)**/test_*.py"', '":(exclude,glob)test_*.py"',
  '":(exclude,glob)**/*_test.py"', '":(exclude,glob)*_test.py"',
  '":(exclude,glob)**/conftest.py"', '":(exclude)conftest.py"'
].join(' ');

/** Diff of `dir` vs baseRef, source-only — this is the SWE-bench patch. */
function capturePatch(dir, baseRef) {
  sh(`git -C "${dir}" add -A`);
  return sh(`git -C "${dir}" diff --cached ${baseRef} -- . ${PATCH_EXCLUDES}`);
}

const REQUEST = (task) =>
  `Resolve the GitHub issue below by editing the repository's SOURCE code only.\n\n` +
  `Follow this protocol:\n` +
  `1. LOCALIZE — explore the repo and find the exact function/lines responsible. Read the ` +
  `surrounding code and related code paths before changing anything.\n` +
  `2. MINIMAL, SURGICAL FIX — make the smallest change that fixes the issue. Prefer adding a ` +
  `guard or branch over rewriting. Do NOT refactor, reformat, or touch unrelated code, and ` +
  `preserve all existing function signatures and behavior.\n` +
  `3. DON'T REGRESS — your change must not break any currently-passing behavior. Trace every ` +
  `call site of the code you touch and confirm each still works. Do NOT run \`pip install\` or ` +
  `otherwise modify anything outside this repository's working tree (no host/global installs).\n` +
  `4. DON'T TOUCH THE PROJECT'S TESTS — do not modify existing test files; the grader supplies its own.\n\n` +
  `# ISSUE\n${task.problem_statement}`;

async function generate(task) {
  const { work, baseRef } = setupWork(task);
  try {
    if (MODE === 'solo') {
      const preset = parseDynamicPreset(MODEL) ?? getDefaultConfig().agent_presets[MODEL];
      if (!preset) throw new Error(`unknown model ${MODEL}`);
      const adapter = new AgentAdapter(preset, TIMEOUT * 60_000, 6);
      await adapter.run({
        mode: 'code',
        prompt: REQUEST(task),
        cwd: work,
        system: 'You are an expert software engineer. Localize the root cause, then fix it with the smallest possible surgical change to the source. Preserve all existing behavior and signatures — never break currently-passing tests. Never modify the project\'s test files.',
        timeoutMs: TIMEOUT * 60_000
      });
      return capturePatch(work, baseRef);
    }
    const cfg = { ...getDefaultConfig(), max_rounds: ROUNDS, max_retries: 6, conventions: false, manifest: { setup: '', build: '', test: '' } };
    const cfgPath = join(work, 'swe.config.json');
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const result = await executeRun({
      repoRoot: work,
      configPath: cfgPath,
      roster: MODEL,
      request: REQUEST(task),
      interactive: false,
      autoApprove: true,
      keepWorktrees: true,
      maxRounds: ROUNDS,
      timeoutMinutes: TIMEOUT
    });
    if (!result.selection) return '';
    // Recover every candidate's diff from its (kept) branch for diversity analysis.
    const winnerId = result.selection.winnerAgentId;
    candidatesByInstance[task.instance_id] = result.selection.scoreboard.map((s) => {
      let patch = '';
      try {
        patch = sh(`git -C "${work}" diff ${baseRef} ${s.branch} -- . ${PATCH_EXCLUDES}`);
      } catch { /* branch may be gone */ }
      return { agentId: s.agentId, score: s.score, meets: s.meets, winner: s.agentId === winnerId, patchLen: patch.length, patch };
    });
    return capturePatch(result.selection.winnerWorktree, baseRef);
  } catch (e) {
    process.stderr.write(`  ${task.instance_id} gen error: ${String(e.message).slice(0, 80)}\n`);
    return '';
  }
}

// ---- main ----
process.stderr.write(`SWE-bench gen — mode=${MODE} model=${MODEL} tasks=${tasks.length} conc=${CONC}\n`);
const model_name = `pangloss-${MODE}-${RUN}`;
const preds = await mapPool(tasks, CONC, async (task) => {
  const patch = await generate(task);
  process.stderr.write(`  ${patch ? '📝' : '∅ '} ${task.instance_id} (${patch.length} chars)\n`);
  return { instance_id: task.instance_id, model_patch: patch, model_name_or_path: model_name };
});

const outPath = join(SWE, `preds-${RUN}.jsonl`);
writeFileSync(outPath, preds.map((p) => JSON.stringify(p)).join('\n') + '\n');
const nonEmpty = preds.filter((p) => p.model_patch.trim()).length;
console.log(`\nwrote ${preds.length} predictions (${nonEmpty} non-empty) to ${outPath}`);

if (Object.keys(candidatesByInstance).length) {
  const candPath = join(SWE, `cands-${RUN}.jsonl`);
  const lines = Object.entries(candidatesByInstance).map(([instance_id, candidates]) =>
    JSON.stringify({ instance_id, candidates })
  );
  writeFileSync(candPath, lines.join('\n') + '\n');
  console.log(`wrote per-lane candidates for ${lines.length} tasks to ${candPath}`);
}
console.log(`score with:\n  python3 -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite \\\n    --predictions_path ${outPath} --run_id ${RUN} --max_workers 4`);
