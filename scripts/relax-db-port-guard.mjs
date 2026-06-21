#!/usr/bin/env node
// Relax a hardcoded DB PORT in a test guard so an app whose tests pin a specific
// Postgres port (e.g. :5432) can run under Pangloss's per-lane port isolation.
//
//   node relax-db-port-guard.mjs <file> [containerPort=5432]
//
// It rewrites `:<containerPort>/<db>` → `:\d+/<db>` inside the guard's connection-
// string regex (so ANY port is accepted) while leaving the credential/db identity
// check intact, then marks the file `git update-index --skip-worktree` so the edit
// is NEVER committed by a lane. Idempotent and non-fatal: if the pattern isn't
// found (guard changed) it warns and exits 0 — the test will simply fail its own
// guard, which is a safe (closed) outcome.
//
// SAFETY: this only widens the ACCEPTED port set; it does not change which DB the
// tests connect to (that's DATABASE_URL, injected by the compose runtime to the
// isolated per-lane port). It must never be used to point tests at a shared DB.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const file = process.argv[2];
const containerPort = process.argv[3] || '5432';
if (!file) {
  console.error('usage: relax-db-port-guard.mjs <file> [containerPort]');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`relax-db-port-guard: ${file} not found — skipping`);
  process.exit(0);
}

const before = readFileSync(file, 'utf8');
// Match the literal `:<port>` that precedes a `/<db>` (escaped or not) in the
// guard regex, and replace the port with `\d+`. Already-relaxed files are a no-op.
const portRe = new RegExp(`:${containerPort}(\\\\?/test_db)`, 'g');
const after = before.replace(portRe, ':\\d+$1');

if (after !== before) {
  writeFileSync(file, after);
  console.log(`relax-db-port-guard: relaxed :${containerPort} → :\\d+ in ${file}`);
} else if (/:\\d\+\\?\/test_db/.test(before)) {
  console.log(`relax-db-port-guard: ${file} already relaxed`);
} else {
  console.warn(`relax-db-port-guard: no :${containerPort}/test_db guard found in ${file} (left unchanged)`);
}

// Never let the relaxation land in a commit.
try {
  execSync(`git update-index --skip-worktree "${file}"`, { stdio: 'ignore' });
} catch {
  // not a git path / not tracked — fine
}
