import chalk from 'chalk';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { AgentAdapter } from './agents/adapter.js';
import { loadConfig, resolveRoster } from './config.js';
import { Logger, RunContext } from './context.js';
import { runPlanPhase } from './phases/plan.js';
import { runCodePhase } from './phases/code.js';
import { runReviewPhase } from './phases/review.js';
import { selectWinner } from './phases/select.js';
import { CodeOutcome, ReviewFinding, SelectionOutcome } from './types.js';
import { WorktreeManager } from './worktree.js';
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
  runId?: string;
}

export interface RunResult {
  runId: string;
  success: boolean;
  selection: SelectionOutcome | null;
  runDir: string;
  error?: string;
}

export async function executeRun(options: RunOptions): Promise<RunResult> {
  const config = await loadConfig(options.configPath);
  const presets = resolveRoster(config, options.roster);
  const adapters = presets.map((p) => new AgentAdapter(p));

  const runId = options.runId ?? generateRunId();
  const runDir = join(options.repoRoot, '.pangloss', 'runs', runId);
  await mkdir(runDir, { recursive: true });

  const logger = createConsoleLogger();
  const baseRef = await currentSha(options.repoRoot);

  logger.info(
    chalk.blue(`\n🌍 Pangloss run ${chalk.bold(runId)} — roster: `) +
      adapters.map((a) => chalk.bold(a.label)).join(chalk.gray(' · '))
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
    timeoutMs: (options.timeoutMinutes ?? config.total_timeout_minutes) * 60_000,
    maxCodeIterations: config.max_code_iterations,
    round: 0
  };

  try {
    // Phase 1
    const plan = await runPlanPhase(ctx);

    // Phase 2
    const { outcomes, worktrees } = await runCodePhase(ctx, plan);
    await writeFile(join(runDir, 'code-outcomes.json'), JSON.stringify(outcomes, null, 2));
    summarizeOutcomes(logger, outcomes);

    // Phase 3
    const findings = await runReviewPhase(ctx, plan, outcomes, worktrees);
    await writeFile(join(runDir, 'reviews.json'), JSON.stringify(findings, null, 2));

    // Phase 4
    const selection = selectWinner(outcomes, findings);
    await writeFile(join(runDir, 'selection.json'), JSON.stringify(selection, null, 2));
    await writeFile(join(runDir, 'summary.md'), renderSummary(runId, outcomes, findings, selection));

    if (!selection) {
      logger.warn('No winner could be selected (no reviewable candidates).');
      return { runId, success: false, selection: null, runDir, error: 'No reviewable candidates.' };
    }

    announceWinner(logger, selection);
    await cleanup(ctx, worktrees, selection, options.keepWorktrees);

    logger.info(chalk.gray(`\nArtifacts: ${join('.pangloss', 'runs', runId)}/`));
    logger.info(chalk.gray(`Winner worktree kept at: ${selection.winnerWorktree}`));
    return { runId, success: true, selection, runDir };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(chalk.red(`Run failed: ${error}`));
    return { runId, success: false, selection: null, runDir, error };
  }
}

async function cleanup(
  ctx: RunContext,
  worktrees: { agentId: string; branch: string; path: string }[],
  selection: SelectionOutcome,
  keepWorktrees: boolean
): Promise<void> {
  if (keepWorktrees) return;
  for (const wt of worktrees) {
    if (wt.agentId === selection.winnerAgentId) continue;
    // Remove the working directory but keep the branch for inspection / PRs.
    await ctx.worktrees.remove(wt, false);
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
    agent: (id, m) => console.log(`  ${chalk.cyan(id.padEnd(14))} ${m}`)
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

function announceWinner(logger: Logger, s: SelectionOutcome): void {
  logger.phase('Phase 4 — Select: best of all possible worlds');
  console.log(chalk.bold('\n🏆 Winner: ') + chalk.green(s.winnerAgentId) + chalk.gray(`  (${s.winnerBranch})`));
  console.log('   ' + s.reason);
  console.log(chalk.bold('\n   Scoreboard:'));
  for (const row of s.scoreboard) {
    const mark = row.agentId === s.winnerAgentId ? chalk.green('►') : ' ';
    console.log(`   ${mark} ${row.agentId.padEnd(14)} ${String(row.score).padStart(5)}/100 ${row.meets ? chalk.green('✓meets') : ''}`);
  }
  if (s.revisionBrief.adoptFromOthers.length) {
    console.log(chalk.bold('\n   Ideas worth grafting from also-rans:'));
    s.revisionBrief.adoptFromOthers.slice(0, 6).forEach((i) => console.log(`     + ${i}`));
  }
}

function renderSummary(
  runId: string,
  outcomes: CodeOutcome[],
  findings: ReviewFinding[],
  selection: SelectionOutcome | null
): string {
  const lines: string[] = [`# Pangloss run ${runId}`, ''];
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
