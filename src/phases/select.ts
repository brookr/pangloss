import { CodeOutcome, ReviewFinding, SelectionOutcome } from '../types.js';

/** Reviews of one's own work are trusted less. */
const SELF_REVIEW_WEIGHT = 0.5;

interface Tally {
  candidate: string;
  branch: string;
  weightedSum: number;
  weight: number;
  meetsVotes: number;
  reviewCount: number;
}

/**
 * Phase 4: aggregate the cross-model reviews into a single decision plus a
 * revision brief. The brief — consolidated must-fixes, novel ideas worth
 * grafting from the also-rans, and what's still needed — is the seam the outer
 * revise-loop (slice 2) will consume.
 */
export function selectWinner(outcomes: CodeOutcome[], findings: ReviewFinding[]): SelectionOutcome | null {
  const outcomeById = new Map(outcomes.map((o) => [o.agentId, o]));

  // Tally weighted scores per candidate.
  const tallies = new Map<string, Tally>();
  for (const f of findings) {
    const weight = f.reviewer === f.candidate ? SELF_REVIEW_WEIGHT : 1.0;
    const t =
      tallies.get(f.candidate) ??
      ({ candidate: f.candidate, branch: f.candidateBranch, weightedSum: 0, weight: 0, meetsVotes: 0, reviewCount: 0 } as Tally);
    t.weightedSum += f.overallScore * weight;
    t.weight += weight;
    t.meetsVotes += f.meetsAcceptanceCriteria ? 1 : 0;
    t.reviewCount += 1;
    tallies.set(f.candidate, t);
  }

  if (tallies.size === 0) return null;

  const scored = [...tallies.values()].map((t) => {
    const outcome = outcomeById.get(t.candidate);
    const green = !!outcome && outcome.build.passed && outcome.tests.failed === 0 && outcome.filesChanged.length > 0;
    const acc = outcome?.acceptance;
    return {
      candidate: t.candidate,
      branch: t.branch,
      score: t.weight > 0 ? t.weightedSum / t.weight : 0,
      meetsVotes: t.meetsVotes,
      testsPassed: outcome?.tests.passed ?? 0,
      remaining: outcome?.remainingWork.length ?? 0,
      green,
      hasAcc: !!acc,
      // Trustworthy signal: implementation graded against the ORIGINAL canonical suite.
      accRate: acc && acc.total > 0 ? acc.passedVsCanonical / acc.total : null,
      weakened: acc?.weakened ?? false
    };
  });

  const gateOn = scored.some((s) => s.hasAcc);

  let pool: typeof scored;
  if (gateOn) {
    // Acceptance gate: a lane cannot win by weakening its own tests — rank by
    // canonical pass-rate first, demote anyone who weakened the contract, keep
    // green as a regression guard, and use review score only to break ties.
    pool = scored.slice().sort(
      (a, b) =>
        Number(a.weakened) - Number(b.weakened) ||
        (b.accRate ?? 0) - (a.accRate ?? 0) ||
        Number(b.green) - Number(a.green) ||
        b.score - a.score ||
        b.meetsVotes - a.meetsVotes ||
        a.remaining - b.remaining
    );
  } else {
    // No gate: original behavior — prefer green, then highest review score.
    pool = scored.some((s) => s.green) ? scored.filter((s) => s.green) : scored;
    pool.sort(
      (a, b) =>
        b.score - a.score ||
        b.meetsVotes - a.meetsVotes ||
        b.testsPassed - a.testsPassed ||
        a.remaining - b.remaining
    );
  }

  const winner = pool[0];
  const winnerOutcome = outcomeById.get(winner.candidate);
  if (!winnerOutcome) return null;

  const revisionBrief = buildRevisionBrief(winner.candidate, findings);

  return {
    winnerAgentId: winner.candidate,
    winnerBranch: winner.branch,
    winnerWorktree: winnerOutcome.worktreePath,
    score: round1(winner.score),
    reason: gateOn
      ? `Acceptance ${winner.accRate !== null ? Math.round(winner.accRate * 100) : '?'}% of canonical` +
        `${winner.weakened ? ' (others weakened — penalized)' : ''}` +
        `${winner.green ? ', build+tests green' : ', not fully green'}` +
        `, review ${round1(winner.score)}/100.`
      : `Highest cross-model score (${round1(winner.score)}/100` +
        `, ${winner.meetsVotes} "meets criteria" vote(s)` +
        `${winner.green ? ', build+tests green' : ', best available though not green'}).`,
    revisionBrief,
    scoreboard: scored
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((s) => ({ agentId: s.candidate, branch: s.branch, score: round1(s.score), meets: s.meetsVotes > 0 }))
  };
}

function buildRevisionBrief(winner: string, findings: ReviewFinding[]) {
  const winnerReviews = findings.filter((f) => f.candidate === winner);
  const otherReviews = findings.filter((f) => f.candidate !== winner);
  return {
    mustFix: dedupe(winnerReviews.flatMap((f) => f.mustFix)),
    // The "best of all possible worlds": novel ideas the winner didn't have but
    // the other candidates did, worth grafting in during revision.
    adoptFromOthers: dedupe(otherReviews.flatMap((f) => f.novelIdeas)),
    stillNeeded: dedupe(winnerReviews.flatMap((f) => f.stillNeeded))
  };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
