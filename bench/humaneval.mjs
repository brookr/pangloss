#!/usr/bin/env node
// HumanEval bench harness for Pangloss.
//
// Modes:
//   baseline  — one model, one bare completion per task (the control)
//   pipeline  — the full Pangloss fusion pipeline per task (added next)
//
// Scoring is the canonical HumanEval check: build `prompt + completion + test +
// check(entry_point)` and run it under python3; exit 0 == pass.
//
// Usage:
//   node bench/humaneval.mjs --mode baseline --model claude:haiku --tasks 8 --runs 2

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { spawnSync, execSync } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentAdapter } from '../dist/agents/adapter.js';
import { getDefaultConfig, parseDynamicPreset } from '../dist/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- args ----
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const MODE = arg('mode', 'baseline');
const MODEL = arg('model', 'claude:haiku');
const N_TASKS = parseInt(arg('tasks', '8'), 10);
const OFFSET = parseInt(arg('offset', '0'), 10);
const RUNS = parseInt(arg('runs', '1'), 10);
const TIMEOUT_MS = parseInt(arg('timeout', '120'), 10) * 1000;

// ---- data ----
function loadTasks() {
  const path = join(HERE, 'data', 'HumanEval.jsonl');
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    console.log('Downloading HumanEval…');
    execSync(`curl -sL https://github.com/openai/human-eval/raw/master/data/HumanEval.jsonl.gz | gunzip > "${path}"`, {
      stdio: 'inherit'
    });
  }
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

// ---- scoring (canonical HumanEval) ----
function score(task, completion) {
  if (!completion || !completion.trim()) return { pass: false, reason: 'empty' };
  const program = `${task.prompt}\n${completion}\n\n${task.test}\n\ncheck(${task.entry_point})\n`;
  const dir = mkdtempSync(join(tmpdir(), 'he-score-'));
  const file = join(dir, 'prog.py');
  writeFileSync(file, program);
  const r = spawnSync('python3', [file], { timeout: 15000, encoding: 'utf8' });
  if (r.status === 0) return { pass: true };
  const err = (r.stderr || '').trim().split('\n').pop() || (r.signal ? `signal ${r.signal}` : 'fail');
  return { pass: false, reason: err.slice(0, 80) };
}

function extractCode(text) {
  const fenced = text.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

// ---- preset resolution (single model) ----
function resolveAdapter(spec) {
  const cfg = getDefaultConfig();
  const preset = parseDynamicPreset(spec) ?? cfg.agent_presets[spec];
  if (!preset) throw new Error(`Unknown model "${spec}"`);
  return new AgentAdapter(preset, TIMEOUT_MS);
}

// ---- baseline: one bare completion ----
async function baseline(adapter, task) {
  const prompt =
    `Complete this Python function. Output ONLY a single \`\`\`python code block ` +
    `containing the COMPLETE function (imports if needed, signature, and body). No prose.\n\n` +
    `\`\`\`python\n${task.prompt}\`\`\``;
  const cwd = mkdtempSync(join(tmpdir(), 'he-bl-'));
  const res = await adapter.run({
    mode: 'plan',
    prompt,
    cwd,
    system: 'You are a precise Python programmer. Reply with code only.',
    timeoutMs: TIMEOUT_MS
  });
  return extractCode(res.stdout);
}

// ---- main ----
const tasks = loadTasks().slice(OFFSET, OFFSET + N_TASKS);
console.log(`HumanEval bench — mode=${MODE} model=${MODEL} tasks=${tasks.length} runs=${RUNS}\n`);

if (MODE !== 'baseline') {
  console.error('Only --mode baseline is implemented in this build.');
  process.exit(1);
}

const adapter = resolveAdapter(MODEL);
const perRun = [];

for (let run = 1; run <= RUNS; run++) {
  let passed = 0;
  const detail = [];
  for (const task of tasks) {
    let completion = '';
    try {
      completion = await baseline(adapter, task);
    } catch (e) {
      detail.push(`  ${task.task_id.padEnd(16)} ERROR ${String(e.message).slice(0, 60)}`);
      continue;
    }
    const s = score(task, completion);
    if (s.pass) passed++;
    detail.push(`  ${task.task_id.padEnd(16)} ${s.pass ? '✅' : '❌ ' + (s.reason ?? '')}`);
  }
  const pct = ((passed / tasks.length) * 100).toFixed(1);
  perRun.push(passed);
  console.log(`Run ${run}: ${passed}/${tasks.length} (${pct}%)`);
  detail.forEach((d) => console.log(d));
  console.log();
}

if (RUNS > 1) {
  const min = Math.min(...perRun);
  const max = Math.max(...perRun);
  const avg = (perRun.reduce((a, b) => a + b, 0) / perRun.length).toFixed(1);
  console.log(`Repeatability over ${RUNS} runs: passed counts = [${perRun.join(', ')}]  min=${min} max=${max} avg=${avg}`);
}
