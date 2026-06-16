import chalk from 'chalk';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { AgentAdapter } from './agents/adapter.js';
import { loadConfig, resolveRoster } from './config.js';
import { Logger, RunContext } from './context.js';
import { runPlanPhase, runRevisionPlan } from './phases/plan.js';
import { runCodePhase } from './phases/code.js';
import { runReviewPhase } from './phases/review.js';
import { selectWinner } from './phases/select.js';
import { CodeOutcome, ReviewFinding, SelectionOutcome } from './types.js';
import { Worktree, WorktreeManager } from './worktree.js';
import { run } from './util/proc.js';

export interface RunOptions {
  repoRoot: string;
  configPath: string;
  roster?: string;
  request?: string;
  interactive: boolean;
  autoApprove: boolean;
  keepWorktrees: boolean;
  timeoutMinutes?: number;
  localTimeoutMinutes?: number;
  maxRounds?: number;
  runId?: string;
}

export interface RunResult {
  runId: string;
  success: boolean;
  selection: SelectionOutcome | null;
  rounds: number;
  runDir: string;
  error?: string;
}

export async function executeRun(options: RunOptions): Promise<RunResult> {
  const config = await loadConfig(options.configPath);
  const presets = resolveRoster(config, options.roster);

  // Per-agent timeouts: local (oss) models get a longer leash than cloud ones,
  // overridable per-preset (timeoutMinutes) or via --timeout / --local-timeout.
  const cloudMin = options.timeoutMinutes ?? config.total_timeout_minutes;
  const localMin = options.localTimeoutMinutes ?? config.local_timeout_minutes;
  const timeoutMinFor = (p: (typeof presets)[number]) =>
    p.timeoutMinutes ?? (p.local || p.oss ? localMin : cloudMin);
  const adapters = presets.map((p) => new AgentAdapter(p, timeoutMinFor(p) * 60_000));

  const runId = options.runId ?? generateRunId();
  const runDir = join(options.repoRoot, '.pangloss', 'runs', runId);
  await mkdir(runDir, { recursive: true });

  const logger = createConsoleLogger();
  const baseRef = await currentSha(options.repoRoot);

  logger.info(
    chalk.blue(`\n🌍 Pangloss run ${chalk.bold(runId)} — roster: `) +
      adapters.map((a) => chalk.bold(a.label)).join(chalk.gray(' · '))
  );
  logger.info(
    chalk.gray('   timeouts: ' + adapters.map((a) => `${a.id} ${Math.round(a.timeoutMs / 60_000)}m`).join(' · '))
  );
  await warnIfDirty(options.repoRoot, logger);

  const ctx: RunContext = {
    config,
    manifest: config.manifest,
    repoRoot: options.repoRoot,
    runId,
    baseRef,
    adapters,
    worktrees: new WorktreeManager(options.repoRoot, runId),
    runDir,
    logger,
    interactive: options.interactive,
    autoApprove: options.autoApprove,
    request: options.request,
    // ctx.timeoutMs is the validation (build/test) cap; model calls use each adapter's own timeout.
    timeoutMs: cloudMin * 60_000,
    maxCodeIterations: config.max_code_iterations,
    round: 0,
    maxRounds: Math.max(1, options.maxRounds ?? config.max_rounds)
  };

  try {
    // Round 0 begins with diverse drafts + synthesis; revision rounds re-plan from the brief.
    let plan = await runPlanPhase(ctx);
    let roundBase = baseRef;
    let selection: SelectionOutcome | null = null;
    let finalWorktrees: Worktree[] = [];
    let roundsRun = 0;

    for (let round = 0; round < ctx.maxRounds; round++) {
      ctx.round = round;
      const roundDir = join(runDir, `round-${round}`);
      await mkdir(roundDir, { recursive: true });
      await writeFile(join(roundDir, 'plan.json'), JSON.stringify(plan, null, 2));

      const { outcomes, worktrees } = await runCodePhase(ctx, plan, roundBase, round > 0);
      await writeFile(join(roundDir, 'code-outcomes.json'), JSON.stringify(outcomes, null, 2));
      summarizeOutcomes(logger, outcomes);

      const findings = await runReviewPhase(ctx, plan, outcomes, worktrees);
      await writeFile(join(roundDir, 'reviews.json'), JSON.stringify(findings, null, 2));

      selection = selectWinner(outcomes, findings);
      finalWorktrees = worktrees;
      roundsRun = round + 1;
      await writeFile(join(roundDir, 'selection.json'), JSON.stringify(selection, null, 2));
      await writeFile(join(roundDir, 'summary.md'), renderSummary(runId, round, outcomes, findings, selection));

      if (!selection) {
        logger.warn('No winner could be selected (no reviewable candidates).');
        return { runId, success: false, selection: null, rounds: roundsRun, runDir, error: 'No reviewable candidates.' };
      }
      announceWinner(logger, selection, round);

      if (isConverged(selection, outcomes)) {
        logger.info(chalk.green(`\n✓ Converged after round ${round}: winner meets criteria with no must-fix / still-needed items.`));
        break;
      }
      if (round === ctx.maxRounds - 1) {
        logger.info(chalk.gray(`\nRound cap (${ctx.maxRounds}) reached.`));
        break;
      }

      // Prepare the next round: drop this round's worktrees (branches are kept;
      // the next round re-bases every agent on the winning branch and revises it).
      if (!options.keepWorktrees) {
        for (const wt of worktrees) await ctx.worktrees.remove(wt, false);
      }
      roundBase = selection.winnerBranch;
      ctx.round = round + 1;
      logger.info(chalk.gray(`\nRevising the winner (${selection.winnerAgentId}) → round ${round + 1}…`));
      plan = await runRevisionPlan(ctx, plan, selection);
    }

    await writeFile(join(runDir, 'final-selection.json'), JSON.stringify({ rounds: roundsRun, selection }, null, 2));
    if (selection) {
      await finalCleanup(ctx, finalWorktrees, selection, options.keepWorktrees);
      logger.info(chalk.gray(`\nArtifacts: ${join('.pangloss', 'runs', runId)}/  (${roundsRun} round(s))`));
      logger.info(chalk.gray(`Winner worktree kept at: ${selection.winnerWorktree}`));
    }
    return { runId, success: Boolean(selection), selection, rounds: roundsRun, runDir };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(chalk.red(`Run failed: ${error}`));
    return { runId, success: false, selection: null, rounds: 0, runDir, error };
  }
}

/** A round has converged when the winner is green, voted to meet criteria, and the brief is empty. */
function isConverged(selection: SelectionOutcome, outcomes: CodeOutcome[]): boolean {
  const winner = outcomes.find((o) => o.agentId === selection.winnerAgentId);
  const green = !!winner && winner.build.passed && winner.tests.failed === 0;
  const meets = selection.scoreboard.find((s) => s.agentId === selection.winnerAgentId)?.meets ?? false;
  const noOpenWork = selection.revisionBrief.mustFix.length === 0 && selection.revisionBrief.stillNeeded.length === 0;
  return green && meets && noOpenWork;
}

async function finalCleanup(
  ctx: RunContext,
  worktrees: Worktree[],
  selection: SelectionOutcome,
  keepWorktrees: boolean
): Promise<void> {
  if (keepWorktrees) return;
  for (const wt of worktrees) {
    if (wt.agentId === selection.winnerAgentId) continue;
    await ctx.worktrees.remove(wt, false); // keep the branch, drop the directory
  }
  ctx.logger.info(chalk.gray('Removed non-winner worktrees (branches kept).'));
}

// --- helpers ---

async function currentSha(repoRoot: string): Promise<string> {
  const res = await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  if (!res.ok) throw new Error('Not a git repository (could not resolve HEAD).');
  return res.stdout.trim();
}

async function warnIfDirty(repoRoot: string, logger: Logger): Promise<void> {
  const res = await run('git', ['status', '--porcelain'], { cwd: repoRoot });
  if (res.ok && res.stdout.trim().length > 0) {
    logger.warn(
      chalk.yellow(
        'Working tree has uncommitted changes; worktrees are cut from the last commit and will NOT include them.'
      )
    );
  }
}

function generateRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

function createConsoleLogger(): Logger {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    phase: (t) => console.log(chalk.bold.magenta(`\n━━ ${t} ━━`)),
    agent: (id, m) => console.log(`  ${chalk.cyan(id.padEnd(16))} ${m}`)
  };
}

function summarizeOutcomes(logger: Logger, outcomes: CodeOutcome[]): void {
  for (const o of outcomes) {
    const status = o.error
      ? chalk.red(`error: ${o.error}`)
      : `${o.build.passed ? chalk.green('build✓') : chalk.red('build✗')} tests ${o.tests.passed}/${o.tests.total} · ${o.filesChanged.length} files · ${(o.durationMs / 1000).toFixed(0)}s`;
    logger.agent(o.agentId, status);
  }
}

function announceWinner(logger: Logger, s: SelectionOutcome, round: number): void {
  logger.phase(`Phase 4 — Select (round ${round}): best of all possible worlds`);
  console.log(chalk.bold('\n🏆 Winner: ') + chalk.green(s.winnerAgentId) + chalk.gray(`  (${s.winnerBranch})`));
  console.log('   ' + s.reason);
  console.log(chalk.bold('\n   Scoreboard:'));
  for (const row of s.scoreboard) {
    const mark = row.agentId === s.winnerAgentId ? chalk.green('►') : ' ';
    console.log(`   ${mark} ${row.agentId.padEnd(16)} ${String(row.score).padStart(5)}/100 ${row.meets ? chalk.green('✓meets') : ''}`);
  }
  if (s.revisionBrief.adoptFromOthers.length) {
    console.log(chalk.bold('\n   Ideas worth grafting from also-rans:'));
    s.revisionBrief.adoptFromOthers.slice(0, 6).forEach((i) => console.log(`     + ${i}`));
  }
}

function renderSummary(
  runId: string,
  round: number,
  outcomes: CodeOutcome[],
  findings: ReviewFinding[],
  selection: SelectionOutcome | null
): string {
  const lines: string[] = [`# Pangloss run ${runId} — round ${round}`, ''];
  lines.push('## Implementations', '');
  for (const o of outcomes) {
    lines.push(
      `- **${o.agentId}** (${o.branch}): build ${o.build.passed ? '✓' : '✗'}, tests ${o.tests.passed}/${o.tests.total}, ${o.filesChanged.length} files${o.error ? `, error: ${o.error}` : ''}`
    );
    if (o.summary) lines.push(`  - ${o.summary}`);
  }
  lines.push('', '## Selection', '');
  if (selection) {
    lines.push(`**Winner: ${selection.winnerAgentId}** — ${selection.reason}`, '');
    lines.push('### Scoreboard');
    selection.scoreboard.forEach((r) => lines.push(`- ${r.agentId}: ${r.score}/100${r.meets ? ' (meets criteria)' : ''}`));
    lines.push('', '### Revision brief (seeds the next round)');
    lines.push('**Must fix:**', ...bullets(selection.revisionBrief.mustFix));
    lines.push('**Adopt from others (novel ideas):**', ...bullets(selection.revisionBrief.adoptFromOthers));
    lines.push('**Still needed:**', ...bullets(selection.revisionBrief.stillNeeded));
  } else {
    lines.push('_No winner selected._');
  }
  lines.push('', `_${findings.length} cross-model reviews recorded._`);
  return lines.join('\n');
}

function bullets(items: string[]): string[] {
  return items.length ? items.map((i) => `- ${i}`) : ['- _none_'];
}
