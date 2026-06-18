import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { runShell } from './util/proc.js';
import { parseTestOutput } from './validate.js';
import { AcceptanceFile } from './types.js';

/**
 * The acceptance gate: spec-derived tests that define "done" objectively.
 * Lanes may refine these tests while implementing, but the trustworthy signal is
 * always the implementation graded against the ORIGINAL canonical suite (C₀) —
 * so a lane can't win by weakening its own copy. This module holds the pure
 * suite plumbing (read/write/diff-signal) and the runner.
 */

const DEFAULT_DIR = 'acceptance';

export function acceptanceDir(dir?: string): string {
  return dir && dir.trim() ? dir.trim().replace(/^\.?\//, '').replace(/\/$/, '') : DEFAULT_DIR;
}

/** Read every file under `<root>/<dir>` as AcceptanceFiles (paths relative to root). */
export function readSuiteDir(root: string, dir: string): AcceptanceFile[] {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  const out: AcceptanceFile[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(root, p), content: readFileSync(p, 'utf8') });
    }
  };
  walk(base);
  return out;
}

/** Replace `<root>/<dir>` entirely with `files` (paths are relative to root). */
export function writeSuiteDir(root: string, dir: string, files: AcceptanceFile[]): void {
  const base = join(root, dir);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  for (const f of files) {
    const abs = join(root, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

export interface AcceptanceRun {
  passed: number;
  failed: number;
  total: number;
  ok: boolean;
  output: string;
}

/** Run the acceptance command in `cwd` and parse its summary. */
export async function runAcceptance(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): Promise<AcceptanceRun> {
  const r = await runShell(cmd, { cwd, timeoutMs, env });
  const out = `${r.stdout}\n${r.stderr}`;
  const parsed = parseTestOutput(out, r.ok);
  return { ...parsed, ok: r.ok && parsed.failed === 0, output: out.slice(-6000) };
}

// --- pure diff signals (corroborate the re-run-vs-canonical verdict) ---

/** Count assertion/test markers across common frameworks (jest/mocha/pytest/etc.). */
export function countAssertions(content: string): number {
  const markers = [/\bexpect\s*\(/g, /\bassert\b/g, /\bit\s*\(/g, /\btest\s*\(/g, /\bdef\s+test_/g];
  return markers.reduce((n, re) => n + (content.match(re)?.length ?? 0), 0);
}

const STRICT = [/\btoEqual\b/g, /\btoBe\b/g, /\btoStrictEqual\b/g, /\btoMatchObject\b/g, /\btoThrow\b/g];
const LOOSE = [/\btoBeTruthy\b/g, /\btoBeDefined\b/g, /\btoBeFalsy\b/g, /\bnot\.toThrow\b/g, /\bany\s*\(/g];
const count = (text: string, res: RegExp[]) => res.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);

export interface WeakeningSignal {
  removedAssertions: boolean;
  loosenedMatchers: boolean;
  detail: string;
}

/**
 * Compare a lane's acceptance tests to the canonical C₀ for signs of weakening:
 * fewer assertions/cases, or strict matchers swapped for loose ones. This only
 * corroborates the authoritative re-run-vs-canonical check.
 */
export function weakeningSignal(canonical: AcceptanceFile[], modified: AcceptanceFile[]): WeakeningSignal {
  const cText = canonical.map((f) => f.content).join('\n');
  const mText = modified.map((f) => f.content).join('\n');
  const cAsserts = countAssertions(cText);
  const mAsserts = countAssertions(mText);
  const removedAssertions = mAsserts < cAsserts;
  const loosenedMatchers = count(mText, STRICT) < count(cText, STRICT) && count(mText, LOOSE) > count(cText, LOOSE);
  const bits: string[] = [];
  if (removedAssertions) bits.push(`assertions ${cAsserts}→${mAsserts}`);
  if (loosenedMatchers) bits.push('strict matchers loosened');
  return { removedAssertions, loosenedMatchers, detail: bits.join('; ') };
}

/** True if the two suites differ in any file content or set of files. */
export function suitesDiffer(a: AcceptanceFile[], b: AcceptanceFile[]): boolean {
  const norm = (fs: AcceptanceFile[]) =>
    JSON.stringify(fs.map((f) => [f.path, f.content]).sort((x, y) => x[0].localeCompare(y[0])));
  return norm(a) !== norm(b);
}
