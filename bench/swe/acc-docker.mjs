#!/usr/bin/env node
// Run a worktree's agent-derived acceptance suite INSIDE the SWE-bench instance
// Docker image — the only place the old pinned-Python repos actually import.
// This is the `acceptanceCmd` for gate-on-SWE runs: Pangloss runs it in the
// lane's worktree, and it prints pytest output that parseTestOutput reads.
//
//   node acc-docker.mjs <instance_id> [acceptanceDir=acceptance]
//
// Layout (from swebench): image sweb.eval.<arch>.<instance>:latest, repo at
// /testbed (editable-installed into the `testbed` conda env). We overlay the
// worktree onto /testbed (keeping the image's .egg-info), then run the suite.

import { execSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const instance = process.argv[2];
const accDir = process.argv[3] || 'acceptance';
const cwd = process.cwd();
if (!instance) {
  console.error('usage: node acc-docker.mjs <instance_id> [acceptanceDir]');
  process.exit(2);
}
if (!existsSync(`${cwd}/${accDir}`)) {
  // No acceptance dir in this worktree → nothing to run (parses as 0/0).
  console.log('no acceptance suite');
  process.exit(0);
}

const sh = (cmd, opts = {}) =>
  execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...opts }).toString();
const quiet = (cmd) => {
  try {
    return sh(cmd);
  } catch {
    return '';
  }
};

function imageFor(inst) {
  // swebench encodes `__` as `_1776_` and may namespace under `swebench/`.
  const enc = inst.replace(/__/g, '_1776_');
  const tags = quiet(`docker images --format '{{.Repository}}:{{.Tag}}'`).split('\n').filter(Boolean);
  const cands = [];
  for (const arch of ['x86_64', 'arm64']) {
    for (const name of [enc, inst]) {
      cands.push(`swebench/sweb.eval.${arch}.${name}:latest`, `sweb.eval.${arch}.${name}:latest`);
    }
  }
  for (const c of cands) if (tags.includes(c)) return c;
  // fuzzy fallback: any sweb.eval image whose tag carries this instance
  return tags.find((t) => t.includes('sweb.eval') && (t.includes(enc) || t.includes(inst))) || null;
}

const image = imageFor(instance);
if (!image) {
  console.error(`instance image for ${instance} not built — run: swebench ... --cache_level instance`);
  process.exit(3);
}

let cid = '';
let stage = '';
try {
  cid = sh(`docker create --platform linux/x86_64 ${image} sleep infinity`).trim();
  sh(`docker start ${cid}`);
  // Overlay the lane's worktree onto /testbed (adds the agent's source changes +
  // the acceptance/ dir; keeps the image's installed-package metadata).
  //
  // Stage to a temp dir WITHOUT .git first: a git worktree's `.git` is a FILE,
  // which `docker cp` cannot write over the image's `/testbed/.git` DIRECTORY — it
  // aborts the whole copy, so the suite never lands and the run looks spuriously
  // red. We also drop .pangloss/node_modules (bloat) and strip macOS xattrs that
  // docker's tar extractor can't apply.
  stage = mkdtempSync(join(tmpdir(), 'acc-stage-'));
  sh(`cp -R "${cwd}/." "${stage}/"`);
  for (const junk of ['.git', '.pangloss', 'node_modules']) rmSync(join(stage, junk), { recursive: true, force: true });
  quiet(`xattr -cr "${stage}"`);
  sh(`COPYFILE_DISABLE=1 docker cp "${stage}/." ${cid}:/testbed/`);
  // Run the acceptance suite in the testbed env; capture output EVEN on a nonzero
  // exit (pytest exits 1 when tests fail — that's the signal, not an error).
  // `-W ignore -o filterwarnings=ignore` so the acceptance suite measures the
  // FEATURE, not the repo's CI warning policy: many SWE-bench repos set
  // `filterwarnings = error`, which would fail our tests on an incidental upstream
  // DeprecationWarning (e.g. werkzeug) that has nothing to do with the change.
  const cmd = `docker exec ${cid} bash -lc "source /opt/miniconda3/bin/activate && conda activate testbed && cd /testbed && python -m pytest ${accDir}/ -q -W ignore -o filterwarnings=ignore -p no:cacheprovider 2>&1"`;
  let out;
  try {
    out = sh(cmd);
  } catch (e) {
    out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
  }
  process.stdout.write(out || 'no output');
} finally {
  if (cid) quiet(`docker rm -f ${cid}`);
  if (stage) rmSync(stage, { recursive: true, force: true });
}
