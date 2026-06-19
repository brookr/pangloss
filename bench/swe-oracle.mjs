#!/usr/bin/env node
// Oracle / complementarity analysis for a diverse SWE-bench run.
//
// Consumes bench/swe/cands-<run>.jsonl (per-lane candidate patches written by
// swebench.mjs --mode diverse) plus the official harness, and reports:
//   - per-lane resolve rate
//   - ORACLE (any lane solves it) = the ceiling fusion could reach with perfect selection
//   - best single lane
//   - what fusion actually selected (preds-<run>.jsonl)
//   - the SELECTION GAP = tasks a lane solved but fusion picked wrong
//   - complementarity = oracle - best-single-lane (the headroom diversity creates)
//
//   node bench/swe-oracle.mjs --run <run-id>
//
// Scores each lane as its own predictions file via the official harness, so it
// requires Docker + the swebench package (same as scoring preds).

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SWE = join(HERE, 'swe');

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
}
const RUN = arg('run', '');
const WORKERS = arg('workers', '4');
if (!RUN) {
  console.error('usage: node bench/swe-oracle.mjs --run <run-id>');
  process.exit(1);
}

const candPath = join(SWE, `cands-${RUN}.jsonl`);
if (!existsSync(candPath)) {
  console.error(`no candidate sidecar at ${candPath} (run swebench.mjs --mode diverse first)`);
  process.exit(1);
}
const rows = readFileSync(candPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Collect the set of lane ids across all tasks.
const lanes = [...new Set(rows.flatMap((r) => r.candidates.map((c) => c.agentId)))];
const sh = (cmd) => execSync(cmd, { stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 1 << 28 }).toString();

function scorePreds(preds, runId) {
  const f = join(SWE, `preds-oracle-${runId}.jsonl`);
  writeFileSync(f, preds.map((p) => JSON.stringify(p)).join('\n') + '\n');
  try {
    sh(
      `python3 -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite ` +
        `--predictions_path "${f}" --run_id oracle-${runId} --max_workers ${WORKERS}`
    );
  } catch {
    /* harness exits nonzero when some instances are unresolved — the report is still written */
  }
  // The harness writes <model_name>.<run_id>.json in cwd.
  const reportGlob = `oracle-${runId}.json`;
  const candidates = sh(`ls *.${'oracle-' + runId}.json 2>/dev/null || true`).trim().split('\n').filter(Boolean);
  const report = candidates[0];
  if (!report || !existsSync(report)) return new Set();
  return new Set(JSON.parse(readFileSync(report, 'utf8')).resolved_ids ?? []);
}

const model = (lane) => `oracle-${RUN}-${lane}`;
console.log(`Oracle analysis for run ${RUN}: ${rows.length} tasks, ${lanes.length} lanes (${lanes.join(', ')})\n`);

const resolvedByLane = {};
for (const lane of lanes) {
  const preds = rows.map((r) => {
    const c = r.candidates.find((x) => x.agentId === lane);
    return { instance_id: r.instance_id, model_patch: c?.patch ?? '', model_name_or_path: model(lane) };
  });
  process.stderr.write(`scoring lane ${lane}…\n`);
  resolvedByLane[lane] = scorePreds(preds, `${RUN}-${lane}`);
}

// Fusion's actual pick (the winner patch) from preds-<run>.jsonl.
let fusionResolved = new Set();
const predsPath = join(SWE, `preds-${RUN}.jsonl`);
if (existsSync(predsPath)) {
  const preds = readFileSync(predsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  process.stderr.write(`scoring fusion pick…\n`);
  fusionResolved = scorePreds(preds.map((p) => ({ ...p, model_name_or_path: model('fusion') })), `${RUN}-fusion`);
}

// Aggregate.
const ids = rows.map((r) => r.instance_id);
const oracle = new Set(ids.filter((id) => lanes.some((l) => resolvedByLane[l].has(id))));
const perLane = lanes.map((l) => ({ lane: l, n: resolvedByLane[l].size }));
const best = perLane.reduce((a, b) => (b.n > a.n ? b : a), { lane: '-', n: 0 });
const selectionGap = [...oracle].filter((id) => !fusionResolved.has(id));

console.log('\n===== RESULTS =====');
for (const { lane, n } of perLane) console.log(`  lane ${lane.padEnd(22)} ${n}/${ids.length}`);
console.log(`  ${'best single lane'.padEnd(27)} ${best.n}/${ids.length} (${best.lane})`);
console.log(`  ${'ORACLE (any lane)'.padEnd(27)} ${oracle.size}/${ids.length}`);
console.log(`  ${'fusion selected'.padEnd(27)} ${fusionResolved.size}/${ids.length}`);
console.log(`\n  complementarity (oracle - best lane): ${oracle.size - best.n}`);
console.log(`  selection gap (a lane solved it, fusion missed): ${selectionGap.length}  ${selectionGap.join(', ')}`);
console.log(`\nReading: complementarity>0 means diversity produces fixes no single lane gets; a large selection gap means generation is fine but SELECT is picking wrong.`);
