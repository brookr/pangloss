import chalk from 'chalk';
import { composeSystem } from '../agents/contract.js';
import { RunContext } from '../context.js';
import { CodeOutcome, PanglossPlan, ReviewFinding } from '../types.js';
import { Worktree } from '../worktree.js';
import { extractJsonBlock } from '../util/extract.js';
import { mapPool } from '../util/pool.js';
import { reviewPrompt } from './prompts.js';

const MAX_DIFF = 14000;

interface RawReview {
  overall_score?: number;
  meets_acceptance_criteria?: boolean;
  sub_scores?: Partial<ReviewFinding['subScores']>;
  novel_ideas?: string[];
  gaps?: string[];
  still_needed?: string[];
  must_fix?: string[];
  acceptance_tests?: { verdict?: string; note?: string };
  confidence?: number;
}

interface CandidateCtx {
  outcome: CodeOutcome;
  worktree: Worktree;
  diff: string;
  /** Anonymized label shown to reviewers in place of the agent id. */
  label: string;
}

/**
 * Phase 3: every agent reviews every candidate implementation, read-only,
 * looking for the best-of-all-worlds — what each got uniquely right, what each
 * missed, and what is still needed.
 */
export async function runReviewPhase(
  ctx: RunContext,
  plan: PanglossPlan,
  outcomes: CodeOutcome[],
  worktrees: Worktree[]
): Promise<ReviewFinding[]> {
  ctx.logger.phase('Phase 3 — Review: every model evaluates every implementation');

  const wtById = new Map(worktrees.map((w) => [w.agentId, w]));
  const candidates: CandidateCtx[] = [];
  for (const outcome of outcomes) {
    if (outcome.filesChanged.length === 0) {
      ctx.logger.agent(outcome.agentId, chalk.gray('no changes — excluded from review'));
      continue;
    }
    const wt = wtById.get(outcome.agentId);
    if (!wt) continue;
    const diff = (await ctx.worktrees.fullDiff(wt, ctx.baseRef)).slice(0, MAX_DIFF);
    candidates.push({ outcome, worktree: wt, diff, label: '' });
  }

  if (candidates.length === 0) {
    ctx.logger.warn('No candidate produced reviewable changes.');
    return [];
  }

  // Blind the reviewers: assign shuffled anonymous labels so no agent can favor
  // (or recognize) its own work. The real agent id is still recorded in findings.
  const pool = candidates.map((_, i) => `Candidate ${String.fromCharCode(65 + i)}`);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  candidates.forEach((c, i) => (c.label = pool[i]));

  // Full reviewer × candidate matrix.
  const jobs = ctx.adapters.flatMap((reviewer) =>
    candidates.map((candidate) => ({ reviewer, candidate }))
  );

  const findings = await mapPool(jobs, ctx.config.max_parallel_agents, async ({ reviewer, candidate }) => {
    const wt = candidate.worktree;
    const startSha = await ctx.worktrees.headSha(wt);
    const res = await reviewer.run({
      mode: 'review',
      prompt: reviewPrompt({
        plan,
        candidateLabel: candidate.label,
        summary: candidate.outcome.summary,
        build: candidate.outcome.build.passed ? 'pass' : 'fail',
        tests: `${candidate.outcome.tests.passed}/${candidate.outcome.tests.total} (failed ${candidate.outcome.tests.failed})`,
        diffStat: candidate.outcome.diffStat ?? '',
        diff: candidate.diff,
        conventions: ctx.conventions?.full ?? null,
        acceptance: candidate.outcome.acceptance
          ? {
              verdict: candidate.outcome.acceptance.verdict,
              passedVsCanonical: candidate.outcome.acceptance.passedVsCanonical,
              total: candidate.outcome.acceptance.total,
              modified: candidate.outcome.acceptance.modified
            }
          : null
      }),
      cwd: wt.path,
      system: composeSystem(reviewer.preset, 'review'),
      timeoutMs: reviewer.timeoutMs,
      onRetry: (m) => ctx.logger.agent(reviewer.id, chalk.yellow(`(reviewing ${candidate.outcome.agentId}) ${m}`))
    });

    const violated = await ctx.worktrees.enforceReadOnly(wt, startSha);
    if (violated) ctx.logger.agent(reviewer.id, chalk.yellow(`mutated ${candidate.outcome.agentId}'s worktree during review — reverted`));

    const raw = extractJsonBlock<RawReview>(res.stdout);
    if (!raw) {
      ctx.logger.agent(reviewer.id, chalk.yellow(`review of ${candidate.outcome.agentId} unparseable`));
      return null;
    }
    ctx.logger.agent(
      reviewer.id,
      `reviewed ${chalk.bold(candidate.outcome.agentId)} → ${clampScore(raw.overall_score)}/100`
    );
    return coerceFinding(raw, reviewer.id, candidate.outcome);
  });

  return findings.filter((f): f is ReviewFinding => f !== null);
}

function coerceFinding(raw: RawReview, reviewer: string, candidate: CodeOutcome): ReviewFinding {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const s = raw.sub_scores ?? {};
  return {
    reviewer,
    candidate: candidate.agentId,
    candidateBranch: candidate.branch,
    overallScore: clampScore(raw.overall_score),
    meetsAcceptanceCriteria: Boolean(raw.meets_acceptance_criteria),
    subScores: {
      correctness: clampScore(s.correctness),
      completeness: clampScore(s.completeness),
      code_quality: clampScore(s.code_quality),
      test_quality: clampScore(s.test_quality),
      maintainability: clampScore(s.maintainability)
    },
    novelIdeas: arr(raw.novel_ideas),
    gaps: arr(raw.gaps),
    stillNeeded: arr(raw.still_needed),
    mustFix: arr(raw.must_fix),
    acceptanceTests: coerceAcceptanceNote(raw.acceptance_tests),
    confidence: clamp01(raw.confidence)
  };
}

function coerceAcceptanceNote(raw?: { verdict?: string; note?: string }): ReviewFinding['acceptanceTests'] {
  if (!raw) return undefined;
  const v = String(raw.verdict ?? '').toLowerCase();
  const verdict = (['clean', 'clarified', 'weakened', 'unsure'].includes(v) ? v : 'unsure') as 'clean' | 'clarified' | 'weakened' | 'unsure';
  return { verdict, note: String(raw.note ?? '').slice(0, 500) };
}

function clampScore(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}
