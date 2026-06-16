import { existsSync } from 'fs';
import { symlink } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import { AgentAdapter } from '../agents/adapter.js';
import { composeSystem } from '../agents/contract.js';
import { RunContext } from '../context.js';
import { CodeOutcome, PanglossPlan } from '../types.js';
import { Worktree } from '../worktree.js';
import { runValidation, ValidationResult } from '../validate.js';
import { createRuntime } from '../runtime.js';
import { runShell } from '../util/proc.js';
import { mapPool } from '../util/pool.js';
import { codePrompt } from './prompts.js';

export interface CodePhaseResult {
  outcomes: CodeOutcome[];
  worktrees: Worktree[];
}

/**
 * Phase 2: each agent implements the plan in its own worktree, validating as it
 * goes. Worktrees are created sequentially (git worktree metadata is not
 * concurrency-safe), then agents run in parallel up to the configured limit.
 *
 * `roundBase` is the git ref each worktree is cut from: the original commit in
 * round 0, the previous round's winning branch in revision rounds (so every
 * agent improves the kept winner). `revision` switches the prompt framing.
 */
export async function runCodePhase(
  ctx: RunContext,
  plan: PanglossPlan,
  roundBase: string,
  revision: boolean
): Promise<CodePhaseResult> {
  const heading = revision
    ? `Phase 2 — Code (round ${ctx.round}): revising the kept winner in parallel`
    : 'Phase 2 — Code: parallel implementation in isolated worktrees';
  ctx.logger.phase(heading);

  // 1. Create all worktrees up front (sequential — git index lock).
  const worktrees: Worktree[] = [];
  for (const adapter of ctx.adapters) {
    const wt = await ctx.worktrees.create(adapter.id, roundBase, ctx.round);
    worktrees.push(wt);
    ctx.logger.agent(adapter.id, chalk.gray(`worktree ${wt.path} on ${wt.branch}`));
  }

  // 2. Run agents in parallel.
  const outcomes = await mapPool(ctx.adapters, ctx.config.max_parallel_agents, async (adapter, idx) => {
    const wt = worktrees[idx];
    const portBase = (ctx.manifest.portBase ?? 4300) + idx * (ctx.manifest.portOffset ?? 10);
    try {
      return await runOneAgent(ctx, adapter, wt, plan, portBase, idx, revision);
    } catch (err) {
      ctx.logger.agent(adapter.id, chalk.red(`failed: ${msg(err)}`));
      return failedOutcome(adapter.id, wt, msg(err));
    }
  });

  return { outcomes, worktrees };
}

async function runOneAgent(
  ctx: RunContext,
  adapter: AgentAdapter,
  wt: Worktree,
  plan: PanglossPlan,
  portBase: number,
  index: number,
  revision: boolean
): Promise<CodeOutcome> {
  const started = Date.now();
  await prepareDeps(ctx, wt, adapter.id);

  // Per-agent runtime: an isolated Docker stack (e.g. its own Postgres) for web
  // apps, or a no-op for simple targets. Brought up before coding, torn down after.
  const runtime = createRuntime({
    manifest: ctx.manifest,
    repoRoot: ctx.repoRoot,
    worktreePath: wt.path,
    runId: ctx.runId,
    agentId: adapter.id,
    index,
    log: (m) => ctx.logger.agent(adapter.id, chalk.gray(m))
  });
  try {
    await runtime.up();
  } catch (err) {
    ctx.logger.agent(adapter.id, chalk.red(`runtime failed: ${msg(err)}`));
    await runtime.down();
    return failedOutcome(adapter.id, wt, `runtime: ${msg(err)}`);
  }

  try {
    const env: NodeJS.ProcessEnv = {
      PANGLOSS_WORKTREE: wt.path,
      PANGLOSS_BRANCH: wt.branch,
      PANGLOSS_SETUP_CMD: ctx.manifest.setup ?? '',
      PANGLOSS_BUILD_CMD: ctx.manifest.build ?? '',
      PANGLOSS_TEST_CMD: ctx.manifest.test ?? '',
      PANGLOSS_E2E_CMD: ctx.manifest.e2e ?? '',
      PANGLOSS_PORT_BASE: String(portBase),
      ...runtime.env
    };

    let validation: ValidationResult | null = null;
    let feedbackTail: string | undefined;

    for (let iter = 1; iter <= ctx.maxCodeIterations; iter++) {
      ctx.logger.agent(adapter.id, `code iteration ${iter}/${ctx.maxCodeIterations}…`);
      const res = await adapter.run({
        mode: 'code',
        prompt: codePrompt(plan, ctx.manifest, { feedbackTail, revision }),
        cwd: wt.path,
        system: composeSystem(adapter.preset, 'code'),
        timeoutMs: adapter.timeoutMs,
        env
      });
      if (res.timedOut) ctx.logger.agent(adapter.id, chalk.yellow(`timed out after ${Math.round(res.durationMs / 1000)}s`));

      validation = await runValidation(ctx.manifest, wt.path, ctx.timeoutMs, { env: runtime.env });
      await ctx.worktrees.commitAll(wt, `pangloss(${adapter.id}): iteration ${iter}`);

      const status = await ctx.worktrees.readStatus(wt);
      const green = isGreen(validation);
      ctx.logger.agent(
        adapter.id,
        `build=${validation.build.passed ? chalk.green('pass') : chalk.red('fail')} ` +
          `tests=${validation.tests.passed}/${validation.tests.total} ` +
          (validation.e2e.ran ? `e2e=${validation.e2e.passed ? chalk.green('pass') : chalk.red('fail')} ` : '') +
          `done=${status?.done ?? false}`
      );

      if (green && (status?.done ?? true)) break;
      if (green) break;

      const changed = await ctx.worktrees.changedFiles(wt, ctx.baseRef);
      if (changed.length === 0 && iter > 1) {
        ctx.logger.agent(adapter.id, chalk.yellow('no changes this iteration — stopping'));
        break;
      }
      feedbackTail = `${validation.build.output}\n${validation.tests.output}\n${validation.e2e.output}`.slice(-3000);
    }

    const status = await ctx.worktrees.readStatus(wt);
    const changed = await ctx.worktrees.changedFiles(wt, ctx.baseRef);
    const diffStat = await ctx.worktrees.diffStat(wt, ctx.baseRef);
    const v = validation;

    return {
      agentId: adapter.id,
      branch: wt.branch,
      worktreePath: wt.path,
      done: status?.done ?? (v ? isGreen(v) : false),
      summary: status?.summary ?? '',
      remainingWork: status?.remaining_work ?? [],
      build: { passed: v?.build.passed ?? false },
      tests: { passed: v?.tests.passed ?? 0, failed: v?.tests.failed ?? 0, total: v?.tests.total ?? 0 },
      filesChanged: changed,
      diffStat,
      notesForReviewers: status?.notes_for_reviewers ?? [],
      durationMs: Date.now() - started
    };
  } finally {
    await runtime.down();
  }
}

/** Green = build passed, no failing unit tests, and e2e (if it ran) passed. */
function isGreen(v: ValidationResult): boolean {
  return v.build.passed && v.tests.failed === 0 && (!v.e2e.ran || v.e2e.passed);
}

/**
 * Give the worktree its dependencies cheaply: symlink the main checkout's
 * node_modules when present (fast path for same-repo dogfooding), otherwise run
 * the manifest's setup command.
 */
async function prepareDeps(ctx: RunContext, wt: Worktree, agentId: string): Promise<void> {
  const rootNM = join(ctx.repoRoot, 'node_modules');
  const wtNM = join(wt.path, 'node_modules');
  if (existsSync(wtNM)) return;

  if (existsSync(rootNM)) {
    try {
      await symlink(rootNM, wtNM, 'dir');
      ctx.logger.agent(agentId, chalk.gray('linked node_modules from main checkout'));
      return;
    } catch {
      // fall through to a real install
    }
  }
  if (ctx.manifest.setup) {
    ctx.logger.agent(agentId, chalk.gray('installing dependencies…'));
    await runShell(ctx.manifest.setup, { cwd: wt.path, timeoutMs: ctx.timeoutMs });
  }
}

function failedOutcome(agentId: string, wt: Worktree, error: string): CodeOutcome {
  return {
    agentId,
    branch: wt.branch,
    worktreePath: wt.path,
    done: false,
    summary: '',
    remainingWork: [],
    build: { passed: false },
    tests: { passed: 0, failed: 0, total: 0 },
    filesChanged: [],
    notesForReviewers: [],
    durationMs: 0,
    error
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
