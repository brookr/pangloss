import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, isAbsolute, join, normalize } from 'path';

/**
 * Worktree file provisioning. Web-app targets need gitignored files (e.g.
 * `apps/web/.env.local`) present in each worktree to build/test/e2e — but
 * worktrees are cut from a commit, so gitignored files are absent. The manifest's
 * `provision` list names repo-relative files to copy from the MAIN checkout into
 * each worktree before `setup` runs.
 *
 * Pure path logic lives here (chalk-free) so it's unit-testable in isolation.
 */

export interface Provision {
  /** Cleaned repo-relative path. */
  rel: string;
  /** Absolute source in the main checkout. */
  from: string;
  /** Absolute destination in the worktree. */
  to: string;
}

/**
 * Resolve manifest `provision` entries to concrete copy operations. Pure (no fs):
 * normalizes each entry, drops empties, absolutes, and parent-escapes (a
 * provisioned path must stay inside both the repo and the worktree), and de-dupes.
 */
export function resolveProvisions(repoRoot: string, worktreePath: string, provision?: string[]): Provision[] {
  if (!Array.isArray(provision)) return [];
  const seen = new Set<string>();
  const out: Provision[] = [];
  for (const raw of provision) {
    // Strip only a leading "./" (relative marker) — NOT a bare "/", so true
    // absolute paths survive to the isAbsolute check below and are rejected.
    const rel = normalize(String(raw ?? '').trim().replace(/^\.\//, '')).replace(/\/+$/, '');
    if (!rel || rel === '.') continue;
    if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) continue; // never escape the worktree
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push({ rel, from: join(repoRoot, rel), to: join(worktreePath, rel) });
  }
  return out;
}

export interface ProvisionResult {
  /** Paths copied into the worktree. */
  copied: string[];
  /** Paths absent (or not a plain file) in the main checkout — skipped, not fatal. */
  missing: string[];
}

/**
 * Copy each provisioned file from the main checkout into the worktree, creating
 * parent directories. Files absent in the main checkout are recorded as `missing`
 * and skipped (not fatal). Existing destination files are overwritten so the
 * worktree always reflects the current main-checkout copy.
 *
 * NOTE: provisioned files should be gitignored in the target repo — they are
 * supplied fresh each run and must not be committed by a lane (the canonical case,
 * `.env.local`, already is).
 */
export function provisionFiles(repoRoot: string, worktreePath: string, provision?: string[]): ProvisionResult {
  const result: ProvisionResult = { copied: [], missing: [] };
  for (const p of resolveProvisions(repoRoot, worktreePath, provision)) {
    if (!existsSync(p.from) || !statSync(p.from).isFile()) {
      result.missing.push(p.rel);
      continue;
    }
    mkdirSync(dirname(p.to), { recursive: true });
    copyFileSync(p.from, p.to);
    result.copied.push(p.rel);
  }
  return result;
}
