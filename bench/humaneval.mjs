#!/usr/bin/env node
// HumanEval bench harness for Pangloss.
//
// Modes:
//   baseline  — one model, one bare completion per task (the control)
//   pipeline  — the full Pangloss fusion pipeline per task (roster of models)
//
// Scoring is the canonical HumanEval check: build `prompt + completion + test +
// check(entry_point)` and run it under python3; exit 0 == pass.
//
// Usage:
//   node bench/humaneval.mjs --mode baseline --model claude:haiku --tasks 8 --runs 2
//   node bench/humaneval.mjs --mode pipeline --model "claude:haiku,gemini:gemini-2.5-flash,openrouter:openai/gpt-oss-20b" --tasks 8

import 'dotenv/config'; // load .env so gemini/OpenRouter lanes get their API keys
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { spawnSync, execSync } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentAdapter } from '../dist/agents/adapter.js';
import { getDefaultConfig, parseDynamicPreset } from '../dist/config.js';
import { executeRun } from '../dist/orchestrator.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const MODE = arg('mode', 'baseline');
const MODEL = arg('model', 'claude:haiku'); // single spec (baseline) or comma roster (pipeline)
const N_TASKS = parseInt(arg('tasks', '8'), 10);
const OFFSET = parseInt(arg('offset', '0'), 10);
const RUNS = parseInt(arg('runs', '1'), 10);
const TIMEOUT_MS = parseInt(arg('timeout', '120'), 10) * 1000;
const QUIET = process.argv.includes('--quiet');

let _saved = null;
function suppressConsole(on) {
  if (on) {
    _saved = console.log;
    console.log = () => {};
  } else if (_saved) {
    console.log = _saved;
    _saved = null;
  }
}

function loadTasks() {
  const path = join(HERE, 'data', 'HumanEval.jsonl');
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    console.log('Downloading HumanEval…');
    execSync(`curl -sL https://github.com/openai/human-eval/raw/master/data/HumanEval.jsonl.gz | gunzip > "${path}"`);
  }
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

function score(task, completion) {
  if (!completion || !completion.trim()) return { pass: false, reason: 'empty solution' };
  const program = `${task.prompt}\n${completion}\n\n${task.test}\n\ncheck(${task.entry_point})\n`;
  const file = join(mkdtempSync(join(tmpdir(), 'he-score-')), 'prog.py');
  writeFileSync(file, program);
  const r = spawnSync('python3', [file], { timeout: 15000, encoding: 'utf8' });
  if (r.status === 0) return { pass: true };
  const err = (r.stderr || '').trim().split('\n').pop() || (r.signal ? `signal ${r.signal}` : 'fail');
  return { pass: false, reason: err.slice(0, 90) };
}

function extractCode(text) {
  const fenced = text.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

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

// ---- pipeline: full fusion pipeline, score the winner's solution.py ----
function setupTaskRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'he-repo-'));
  const cfg = {
    ...getDefaultConfig(),
    manifest: {
      build: 'python3 -m py_compile solution.py',
      test: "python3 -m unittest discover -q -p 'test_*.py'"
    }
  };
  writeFileSync(join(dir, 'pangloss.config.json'), JSON.stringify(cfg, null, 2));
  writeFileSync(join(dir, '.gitignore'), '.pangloss/\n');
  writeFileSync(join(dir, 'README.md'), '# bench task\n');
  execSync('git init -q && git add -A && git -c user.email=b@b.co -c user.name=bench commit -q -m init', { cwd: dir });
  return dir;
}

async function pipeline(roster, task) {
  const dir = setupTaskRepo();
  const request =
    `Implement the following Python function. Create a file named solution.py containing the COMPLETE function ` +
    `(necessary imports, the EXACT signature, and a correct body — do not change the signature). Also create ` +
    `test_solution.py with a few unittest TestCase checks derived from the docstring examples and make them pass.\n\n` +
    `\`\`\`python\n${task.prompt}\`\`\``;
  const result = await executeRun({
    repoRoot: dir,
    configPath: join(dir, 'pangloss.config.json'),
    roster,
    request,
    interactive: false,
    autoApprove: true,
    keepWorktrees: true,
    maxRounds: 1,
    timeoutMinutes: 8,
    localTimeoutMinutes: 20
  });
  if (!result.selection) return '';
  const sol = join(result.selection.winnerWorktree, 'solution.py');
  return existsSync(sol) ? readFileSync(sol, 'utf8') : '';
}

// ---- main ----
const tasks = loadTasks().slice(OFFSET, OFFSET + N_TASKS);
console.log(`HumanEval bench — mode=${MODE} model=${MODEL} tasks=${tasks.length} runs=${RUNS}\n`);

const adapter = MODE === 'baseline' ? resolveAdapter(MODEL) : null;
const perRun = [];

for (let run = 1; run <= RUNS; run++) {
  let passed = 0;
  const detail = [];
  for (const task of tasks) {
    let completion = '';
    let err = null;
    try {
      if (QUIET) suppressConsole(true);
      completion = MODE === 'baseline' ? await baseline(adapter, task) : await pipeline(MODEL, task);
    } catch (e) {
      err = e;
    } finally {
      if (QUIET) suppressConsole(false);
    }
    if (err) {
      detail.push(`  ${task.task_id.padEnd(16)} ERROR ${String(err.message).slice(0, 70)}`);
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
  console.log(`Repeatability over ${RUNS} runs: passed = [${perRun.join(', ')}]  min=${min} max=${max} avg=${avg}`);
}
