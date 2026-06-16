import { selectWinner } from '../src/phases/select.js';
import type { CodeOutcome, ReviewFinding } from '../src/types.js';

function outcome(id: string, opts: Partial<CodeOutcome> & { green: boolean }): CodeOutcome {
  const green = opts.green;
  return {
    agentId: id,
    branch: `pangloss/run/${id}`,
    worktreePath: `/wt/${id}`,
    done: green,
    summary: `${id} summary`,
    remainingWork: opts.remainingWork ?? [],
    build: { passed: green },
    tests: { passed: green ? 2 : 0, failed: green ? 0 : 1, total: 2 },
    filesChanged: ['file.ts'],
    notesForReviewers: [],
    durationMs: 1000,
    ...opts
  };
}

function finding(
  reviewer: string,
  candidate: string,
  score: number,
  extra: Partial<ReviewFinding> = {}
): ReviewFinding {
  return {
    reviewer,
    candidate,
    candidateBranch: `pangloss/run/${candidate}`,
    overallScore: score,
    meetsAcceptanceCriteria: score >= 70,
    subScores: { correctness: score, completeness: score, code_quality: score, test_quality: score, maintainability: score },
    novelIdeas: [],
    gaps: [],
    stillNeeded: [],
    mustFix: [],
    confidence: 0.9,
    ...extra
  };
}

describe('selectWinner', () => {
  const outcomes: CodeOutcome[] = [
    outcome('A', { green: true }),
    outcome('B', { green: true }),
    outcome('C', { green: false }) // high-scoring but broken
  ];

  const findings: ReviewFinding[] = [
    // A's reviews
    finding('A', 'A', 90), // self-review, down-weighted
    finding('A', 'B', 70, { mustFix: ['fix-b1'] }),
    finding('A', 'C', 100, { novelIdeas: ['idea-c'] }),
    // B's reviews
    finding('B', 'A', 60, { novelIdeas: ['idea-a'] }),
    finding('B', 'B', 80), // self-review, down-weighted
    finding('B', 'C', 100),
    // C's reviews
    finding('C', 'A', 50),
    finding('C', 'B', 75, { mustFix: ['fix-b2'] }),
    finding('C', 'C', 100) // self-review, down-weighted
  ];

  it('prefers a green candidate over a higher-scoring broken one', () => {
    const sel = selectWinner(outcomes, findings);
    expect(sel).not.toBeNull();
    // C scores 100 but is not green, so it is excluded from the winner pool.
    expect(sel!.winnerAgentId).not.toBe('C');
  });

  it('picks the highest weighted score among green candidates (self-reviews down-weighted)', () => {
    const sel = selectWinner(outcomes, findings)!;
    // Weighted: A = (90*.5 + 60 + 50)/2.5 = 62 ; B = (70 + 80*.5 + 75)/2.5 = 74
    expect(sel.winnerAgentId).toBe('B');
    expect(sel.score).toBeCloseTo(74, 1);
  });

  it('consolidates must-fixes for the winner and grafts novel ideas from the others', () => {
    const sel = selectWinner(outcomes, findings)!;
    expect(sel.revisionBrief.mustFix.sort()).toEqual(['fix-b1', 'fix-b2']);
    // Novel ideas come from reviews of NON-winner candidates (A and C).
    expect(sel.revisionBrief.adoptFromOthers.sort()).toEqual(['idea-a', 'idea-c']);
  });

  it('returns a scoreboard covering every candidate', () => {
    const sel = selectWinner(outcomes, findings)!;
    expect(sel.scoreboard.map((s) => s.agentId).sort()).toEqual(['A', 'B', 'C']);
  });

  it('returns null when there are no findings', () => {
    expect(selectWinner(outcomes, [])).toBeNull();
  });
});
