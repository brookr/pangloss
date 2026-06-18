import { runShell } from './util/proc.js';
import { TargetManifest } from './types.js';

export interface ValidationResult {
  build: { ran: boolean; passed: boolean; output: string };
  tests: { ran: boolean; passed: number; failed: number; total: number; output: string };
  e2e: { ran: boolean; passed: boolean; output: string };
}

export interface ValidationOpts {
  onLog?: (s: string) => void;
  /** Extra env (e.g. DATABASE_URL from the per-agent runtime) merged over process.env. */
  env?: NodeJS.ProcessEnv;
}

const TAIL = 6000;

/** Run the manifest's build + test (+ optional e2e) commands in `cwd` and parse the outcome. */
export async function runValidation(
  manifest: TargetManifest,
  cwd: string,
  timeoutMs: number,
  opts: ValidationOpts = {}
): Promise<ValidationResult> {
  const { onLog, env } = opts;
  const result: ValidationResult = {
    build: { ran: false, passed: true, output: '' },
    tests: { ran: false, passed: 0, failed: 0, total: 0, output: '' },
    e2e: { ran: false, passed: true, output: '' }
  };

  if (manifest.build) {
    const r = await runShell(manifest.build, { cwd, timeoutMs, onLog, env });
    const out = `${r.stdout}\n${r.stderr}`;
    result.build = { ran: true, passed: r.ok, output: out.slice(-TAIL) };
  }

  if (manifest.test) {
    const r = await runShell(manifest.test, { cwd, timeoutMs, onLog, env });
    const out = `${r.stdout}\n${r.stderr}`;
    const parsed = parseTestOutput(out, r.ok);
    result.tests = { ran: true, ...parsed, output: out.slice(-TAIL) };
  }

  if (manifest.e2e) {
    const r = await runShell(manifest.e2e, { cwd, timeoutMs, onLog, env });
    const out = `${r.stdout}\n${r.stderr}`;
    result.e2e = { ran: true, passed: r.ok, output: out.slice(-TAIL) };
  }

  return result;
}

/**
 * Best-effort parse of test runner output. Understands Jest's summary line and
 * Mocha-style "N passing / N failing". Falls back to the process exit status.
 */
export function parseTestOutput(
  output: string,
  ok: boolean
): { passed: number; failed: number; total: number } {
  // Jest: "Tests:       2 failed, 1 skipped, 5 passed, 8 total"
  const jestLine = output.split('\n').find((l) => /^\s*Tests:/.test(l));
  if (jestLine) {
    const passed = num(jestLine.match(/(\d+)\s+passed/));
    const failed = num(jestLine.match(/(\d+)\s+failed/));
    const total = num(jestLine.match(/(\d+)\s+total/)) || passed + failed;
    return { passed, failed, total };
  }

  // Vitest: "Tests  2 failed | 10 passed (12)"  — two spaces, NO colon, parenthesized grand total
  const vitestLine = output.split('\n').find((l) => /^\s*Tests\s{2,}/.test(l));
  if (vitestLine) {
    const total = num(vitestLine.match(/\((\d+)\)/));
    const passed = num(vitestLine.match(/(\d+)\s+passed/));
    const failed = num(vitestLine.match(/(\d+)\s+failed/));
    return { passed, failed, total: total || passed + failed };
  }

  // Mocha / generic: "12 passing", "3 failing"
  const passing = output.match(/(\d+)\s+passing/);
  const failing = output.match(/(\d+)\s+failing/);
  if (passing || failing) {
    const passed = num(passing);
    const failed = num(failing);
    return { passed, failed, total: passed + failed };
  }

  // pytest: "5 passed in 0.1s", "2 failed, 3 passed", "1 error"
  const pyPass = output.match(/(\d+) passed/);
  const pyFail = output.match(/(\d+) failed/);
  const pyErr = output.match(/(\d+) error/);
  if (pyPass || pyFail || pyErr) {
    const passed = num(pyPass);
    const failed = num(pyFail) + num(pyErr);
    return { passed, failed, total: passed + failed };
  }

  // Nothing parseable — infer from exit code so a green run isn't recorded as 0/0.
  return ok ? { passed: 1, failed: 0, total: 1 } : { passed: 0, failed: 1, total: 1 };
}

function num(m: RegExpMatchArray | null): number {
  return m ? parseInt(m[1], 10) || 0 : 0;
}
