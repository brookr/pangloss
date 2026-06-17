#!/usr/bin/env node
// Aider polyglot (Exercism) bench harness for Pangloss — Python subset.
//
// Each exercise: instructions + a stub <name>.py + comprehensive <name>_test.py.
// The agent implements the stub; we score by running the ORIGINAL test against
// the agent's solution in a clean dir (so agents can't tamper with the tests).
//
// Modes:
//   baseline  — one model, one completion
//   pipeline  — full Pangloss fusion pipeline (comma roster)
//
// Runs tasks in PARALLEL (--concurrency, default 5).
//
//   node bench/polyglot.mjs --mode baseline --model claude:sonnet --tasks 12 --concurrency 6
//   node bench/polyglot.mjs --mode pipeline --model "claude:sonnet,gemini:gemini-2.5-flash,openrouter:qwen/qwen3-coder" --tasks 12 --concurrency 4

import 'dotenv/config'; // load .env so gemini/OpenRouter lanes get their API keys (claude/cursor use OAuth)
import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync } from 'fs';
import { spawnSync, execSync } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentAdapter } from '../dist/agents/adapter.js';
import { getDefaultConfig, parseDynamicPreset } from '../dist/config.js';
import { executeRun } from '../dist/orchestrator.js';
import { mapPool } from '../dist/util/pool.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRACTICE = join(HERE, 'polyglot', 'python', 'exercises', 'practice');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const MODE = arg('mode', 'baseline');
const MODEL = arg('model', 'claude:sonnet');
const N = parseInt(arg('tasks', '10'), 10);
const OFFSET = parseInt(arg('offset', '0'), 10);
const CONCURRENCY = parseInt(arg('concurrency', '5'), 10);
const TIMEOUT_MS = parseInt(arg('timeout', '180'), 10) * 1000;

function loadExercises() {
  const names = readdirSync(PRACTICE).filter((n) => existsSync(join(PRACTICE, n, '.docs'))).sort();
  const exs = [];
  for (const name of names) {
    const dir = join(PRACTICE, name);
    const pys = readdirSync(dir).filter((f) => f.endsWith('.py'));
    const testName = pys.find((f) => f.endsWith('_test.py'));
    const stubName = pys.find((f) => f !== testName);
    if (!testName || !stubName) continue;
    let instructions = readFileSync(join(dir, '.docs', 'instructions.md'), 'utf8');
    const appendPath = join(dir, '.docs', 'instructions.append.md');
    if (existsSync(appendPath)) instructions += '\n\n' + readFileSync(appendPath, 'utf8');
    exs.push({
      name,
      stubName,
      testName,
      stub: readFileSync(join(dir, stubName), 'utf8'),
      testPath: join(dir, testName),
      instructions
    });
  }
  return exs.slice(OFFSET, OFFSET + N);
}

// Score: run the ORIGINAL test against the candidate solution in a clean dir.
function scoreSolution(ex, code) {
  if (!code || !code.trim()) return { pass: false, reason: 'empty solution' };
  const dir = mkdtempSync(join(tmpdir(), 'pg-score-'));
  writeFileSync(join(dir, ex.stubName), code);
  copyFileSync(ex.testPath, join(dir, ex.testName));
  const r = spawnSync('python3', ['-m', 'pytest', '-q', '-x', ex.testName], { cwd: dir, timeout: 30000, encoding: 'utf8' });
  if (r.status === 0) return { pass: true };
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/(\d+) failed/) || out.match(/error/i);
  return { pass: false, reason: (r.signal ? `signal ${r.signal}` : (m ? m[0] : 'fail')).slice(0, 40) };
}

function extractCode(text) {
  const fenced = text.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function resolveAdapter(spec) {
  const cfg = getDefaultConfig();
  const preset = parseDynamicPreset(spec) ?? cfg.agent_presets[spec];
  if (!preset) throw new Error(`Unknown model "${spec}"`);
  return new AgentAdapter(preset, TIMEOUT_MS, 10); // generous retries for free/rate-limited tiers
}

async function baseline(adapter, ex) {
  const prompt =
    `Implement the Python exercise below. Output ONLY a single \`\`\`python code block with the COMPLETE ` +
    `contents of ${ex.stubName} (keep the required function/class names). No prose.\n\n` +
    `# INSTRUCTIONS\n${ex.instructions}\n\n# STUB (${ex.stubName})\n\`\`\`python\n${ex.stub}\`\`\``;
  const cwd = mkdtempSync(join(tmpdir(), 'pg-bl-'));
  const res = await adapter.run({
    mode: 'plan',
    prompt,
    cwd,
    system: 'You are an expert Python programmer. Reply with code only.',
    timeoutMs: TIMEOUT_MS
  });
  return extractCode(res.stdout);
}

function setupRepo(ex) {
  const dir = mkdtempSync(join(tmpdir(), 'pg-repo-'));
  writeFileSync(join(dir, ex.stubName), ex.stub);
  copyFileSync(ex.testPath, join(dir, ex.testName));
  writeFileSync(join(dir, 'INSTRUCTIONS.md', ), ex.instructions);
  writeFileSync(join(dir, '.gitignore'), '.pangloss/\n');
  // Explicitly null setup/build so the default yarn manifest doesn't leak into the python task.
  const cfg = {
    ...getDefaultConfig(),
    max_retries: 10,
    manifest: { setup: '', build: '', test: `python3 -m pytest -q ${ex.testName}` }
  };
  writeFileSync(join(dir, 'pangloss.config.json'), JSON.stringify(cfg, null, 2));
  execSync('git init -q && git add -A && git -c user.email=b@b.co -c user.name=bench commit -q -m init', { cwd: dir });
  return dir;
}

async function pipeline(roster, ex) {
  const dir = setupRepo(ex);
  const request =
    `Implement ${ex.stubName} so the tests in ${ex.testName} pass. Keep the required public names. ` +
    `Do not modify ${ex.testName}.\n\n# INSTRUCTIONS\n${ex.instructions}`;
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
    localTimeoutMinutes: 25
  });
  if (!result.selection) return '';
  const sol = join(result.selection.winnerWorktree, ex.stubName);
  return existsSync(sol) ? readFileSync(sol, 'utf8') : '';
}

// ---- main (parallel) ----
const exercises = loadExercises();
console.log(`Polyglot(python) — mode=${MODE} model=${MODEL} tasks=${exercises.length} concurrency=${CONCURRENCY}\n`);
const adapter = MODE === 'baseline' ? resolveAdapter(MODEL) : null;
const started = Date.now();

const results = await mapPool(exercises, CONCURRENCY, async (ex) => {
  try {
    const code = MODE === 'baseline' ? await baseline(adapter, ex) : await pipeline(MODEL, ex);
    const r = { name: ex.name, ...scoreSolution(ex, code) };
    process.stderr.write(`  ${r.pass ? '✅' : '❌'} ${ex.name}\n`); // progress on stderr
    return r;
  } catch (e) {
    process.stderr.write(`  ❌ ${ex.name} (err)\n`);
    return { name: ex.name, pass: false, reason: `ERR ${String(e.message).slice(0, 40)}` };
  }
});

const passed = results.filter((r) => r.pass).length;
console.log(`\nResult: ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(1)}%) in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  ${r.name.padEnd(22)} ${r.pass ? '✅' : '❌ ' + (r.reason ?? '')}`);
}
