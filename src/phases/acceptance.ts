import { existsSync } from 'fs';
import { symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import { composeSystem } from '../agents/contract.js';
import { RunContext } from '../context.js';
import { AcceptanceAudit, AcceptanceFile, AcceptanceSuite, CodeOutcome, PanglossPlan } from '../types.js';
import { Worktree } from '../worktree.js';
import { extractJsonBlock } from '../util/extract.js';
import { mapPool } from '../util/pool.js';
import {
  acceptanceDir,
  readSuiteDir,
  runAcceptance,
  sanitizeSuitePath,
  suitesDiffer,
  weakeningSignal,
  writeSuiteDir
} from '../acceptance.js';
import { acceptanceDraftPrompt, acceptanceSynthPrompt } from './prompts.js';
import { pickSynthesizer } from './plan.js';

interface RawSuite {
  files?: { path?: string; content?: string }[];
  criteria_covered?: string[];
}

/**
 * Phase 1.5 — turn the plan's acceptance_criteria into an executable, canonical
 * acceptance suite (C₀): N agents draft tests, a rotating synthesizer merges them,
 * and we confirm the suite FAILS on the base code (non-vacuous). Returns null when
 * the gate is disabled (no manifest.acceptanceCmd) or no suite could be built.
 */
export interface AcceptancePhaseResult {
  suite: AcceptanceSuite;
  /** New base commit (= original base + the canonical suite) the worktrees should be cut from. */
  baseRef: string;
}

export async function runAcceptancePhase(ctx: RunContext, plan: PanglossPlan): Promise<AcceptancePhaseResult | null> {
  if (!ctx.manifest.acceptanceCmd) return null;
  ctx.logger.phase('Phase 1.5 — Acceptance: derive the objective gate from the plan');
  const dir = acceptanceDir(ctx.manifest.acceptanceDir);

  // --- diverse drafts ---
  const drafts = (
    await mapPool(ctx.adapters, ctx.config.max_parallel_agents, async (adapter) => {
      try {
        const res = await adapter.run({
          mode: 'plan',
          prompt: acceptanceDraftPrompt(plan, dir, ctx.conventions?.full),
          cwd: ctx.repoRoot,
          system: composeSystem(adapter.preset, 'plan'),
          timeoutMs: adapter.timeoutMs,
          onRetry: (m) => ctx.logger.agent(adapter.id, chalk.yellow(m))
        });
        const files = normalizeFiles(extractJsonBlock<RawSuite>(res.stdout), dir);
        if (!files.length) {
          ctx.logger.agent(adapter.id, chalk.yellow('acceptance draft unparseable — skipped'));
          return null;
        }
        ctx.logger.agent(adapter.id, chalk.green(`drafted ${files.length} acceptance file(s)`));
        return files;
      } catch (err) {
        ctx.logger.agent(adapter.id, chalk.yellow(`acceptance draft errored — skipped (${err instanceof Error ? err.message : String(err)})`));
        return null;
      }
    })
  ).filter((f): f is AcceptanceFile[] => f !== null);

  if (drafts.length === 0) {
    ctx.logger.warn('No agent produced an acceptance suite — the gate is disabled for this run.');
    return null;
  }

  // --- rotated synthesis ---
  const synth = pickSynthesizer(ctx);
  ctx.logger.info(`Synthesizing acceptance suite via ${chalk.bold(synth.label)}…`);
  const res = await synth.run({
    mode: 'synthesize',
    prompt: acceptanceSynthPrompt(plan, dir, drafts),
    cwd: ctx.repoRoot,
    system: composeSystem(synth.preset, 'synthesize'),
    timeoutMs: synth.timeoutMs
  });
  let files = normalizeFiles(extractJsonBlock<RawSuite>(res.stdout), dir);
  if (files.length === 0) {
    ctx.logger.warn('Acceptance synthesis unparseable; falling back to the strongest draft.');
    files = drafts.sort((a, b) => b.length - a.length)[0];
  }

  // --- red-on-base check + materialize the suite into a new base commit ---
  const { redOnBase, baseRef } = await materializeBase(ctx, dir, files);
  ctx.logger.info(
    redOnBase
      ? chalk.green(`✓ Acceptance suite is red on base (${files.length} file(s)) — it tests the new behavior.`)
      : chalk.yellow('⚠ Acceptance suite PASSES on the base code — it may be vacuous (not testing the new behavior).')
  );

  const suite: AcceptanceSuite = { files, criteria: plan.acceptance_criteria, redOnBase };
  await writeFile(join(ctx.runDir, 'acceptance-canonical.json'), JSON.stringify(suite, null, 2));
  return { suite, baseRef };
}

/**
 * Write the canonical suite into a worktree cut from the current base, confirm it
 * fails there (red-on-base), then commit it — yielding a new base commit that every
 * lane is cut from. The suite thus lives in the base (out of each lane's diff) and
 * a lane editing it shows up cleanly as a diff against this base.
 */
async function materializeBase(
  ctx: RunContext,
  dir: string,
  files: AcceptanceFile[]
): Promise<{ redOnBase: boolean; baseRef: string }> {
  const wt = await ctx.worktrees.create('_acceptance_base', ctx.baseRef, ctx.round);
  let redOnBase = false;
  try {
    await linkNodeModules(ctx.repoRoot, wt.path);
    writeSuiteDir(wt.path, dir, files);
    try {
      const run = await runAcceptance(ctx.manifest.acceptanceCmd!, wt.path, ctx.timeoutMs);
      redOnBase = run.failed > 0 || !run.ok; // green here ⇒ vacuous
    } catch (err) {
      ctx.logger.warn(`red-on-base check failed to run: ${err instanceof Error ? err.message : String(err)}`);
    }
    await ctx.worktrees.commitAll(wt, 'pangloss: acceptance suite (base)');
    const baseRef = await ctx.worktrees.headSha(wt);
    return { redOnBase, baseRef: baseRef || ctx.baseRef };
  } finally {
    // Drop the worktree directory but KEEP the branch so the new base commit stays reachable.
    await ctx.worktrees.remove(wt, false);
  }
}

/**
 * Audit one lane against the acceptance contract. The trustworthy number is
 * `passedVsCanonical` — the lane's implementation graded against the ORIGINAL
 * suite, regardless of what the lane did to its own copy.
 */
export async function auditLane(
  ctx: RunContext,
  outcome: CodeOutcome,
  wt: Worktree
): Promise<AcceptanceAudit | undefined> {
  if (!ctx.acceptanceSuite || !ctx.manifest.acceptanceCmd) return undefined;
  const dir = acceptanceDir(ctx.manifest.acceptanceDir);
  const canonical = ctx.acceptanceSuite.files;
  const cmd = ctx.manifest.acceptanceCmd;

  const laneFiles = readSuiteDir(wt.path, dir);
  const modified = laneFiles.length > 0 ? suitesDiffer(canonical, laneFiles) : true;

  // 1. lane's implementation vs its OWN (possibly modified) suite
  const modRun = await runAcceptance(cmd, wt.path, ctx.timeoutMs);
  // 2. lane's implementation vs the ORIGINAL canonical suite (swap in, run, ALWAYS restore).
  // The try/finally guarantees the lane's own suite is restored even if the run
  // throws/times out — otherwise the selected branch could be left holding the
  // canonical suite (or an empty dir), silently mutating the winner.
  let origRun;
  try {
    writeSuiteDir(wt.path, dir, canonical);
    origRun = await runAcceptance(cmd, wt.path, ctx.timeoutMs);
  } finally {
    if (laneFiles.length > 0) writeSuiteDir(wt.path, dir, laneFiles);
  }

  const total = origRun.total || canonical.length;
  const weakSig = weakeningSignal(canonical, laneFiles);
  // Objective weakening: passes its own suite but fails the real bar (moved the
  // goalposts), or removed/loosened assertions while still failing canonical.
  const movedGoalposts = modified && origRun.failed > 0 && modRun.failed === 0;
  const gutted = modified && (weakSig.removedAssertions || weakSig.loosenedMatchers) && origRun.failed > 0;
  const weakened = movedGoalposts || gutted;
  const verdict: AcceptanceAudit['verdict'] = !modified
    ? 'clean'
    : origRun.failed === 0
      ? 'clarified'
      : weakened
        ? 'weakened'
        : 'clean';

  const detail =
    `${origRun.passed}/${total} vs canonical, ${modRun.passed}/${modRun.total || total} vs own suite` +
    (modified ? ` · tests modified${weakSig.detail ? ` (${weakSig.detail})` : ''}` : '') +
    (verdict === 'weakened' ? ' · WEAKENED' : verdict === 'clarified' ? ' · clarified' : '');

  const colour = verdict === 'weakened' ? chalk.red : verdict === 'clarified' ? chalk.cyan : chalk.gray;
  ctx.logger.agent(outcome.agentId, colour(`acceptance ${origRun.passed}/${total} canonical · ${verdict}`));

  return {
    total,
    passedVsCanonical: origRun.passed,
    passedVsModified: modRun.passed,
    modified,
    weakened,
    verdict,
    detail
  };
}

function normalizeFiles(raw: RawSuite | null, dir: string): AcceptanceFile[] {
  if (!raw?.files?.length) return [];
  const seen = new Set<string>();
  const out: AcceptanceFile[] = [];
  for (const f of raw.files) {
    if (!f || typeof f.content !== 'string' || !f.content.trim()) continue;
    let path = String(f.path ?? '').trim().replace(/^\.?\//, '');
    if (!path) continue;
    if (!path.startsWith(`${dir}/`)) path = `${dir}/${path.replace(new RegExp(`^${dir}/?`), '')}`;
    path = sanitizeSuitePath(path);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, content: f.content });
  }
  return out;
}

async function linkNodeModules(repoRoot: string, wtPath: string): Promise<void> {
  const rootNM = join(repoRoot, 'node_modules');
  const wtNM = join(wtPath, 'node_modules');
  if (existsSync(rootNM) && !existsSync(wtNM)) {
    await symlink(rootNM, wtNM, 'dir').catch(() => undefined);
  }
}
