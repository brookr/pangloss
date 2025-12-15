import { AgentResult } from './types.js';

export interface WinnerSelection {
  winner_branch: string;
  winner_agent_id: string;
  score: number;
  consolidated_recommendations: string[];
  reason: string;
}

interface ScoreBreakdownEntry {
  judge: string;
  score: number;
  weight: number;
}

export class ResultAggregator {
  
  selectWinner(results: AgentResult[], judgements: AgentResult[]): WinnerSelection | null {
    // 1. Filter eligible candidates (Build must pass)
    // We look at the generation results for build status
    const eligibleBranches = new Set<string>();
    const branchToGenResult = new Map<string, AgentResult>();

    for (const res of results) {
      if (res.mode === 'generate' && res.success && res.build_status === 'success') {
        eligibleBranches.add(res.branch_name);
        branchToGenResult.set(res.branch_name, res);
      }
    }

    if (eligibleBranches.size === 0) {
      return null;
    }

    // 2. Aggregate scores from judgements
    // Map branch -> scores[]
    const scores = new Map<string, { total: number; count: number; breakdown: ScoreBreakdownEntry[] }>();

    // judgements is an array of AgentResult (from judge mode), each containing .judgements[]
    for (const judgeResult of judgements) {
      if (!judgeResult.judgements) continue;

      for (const j of judgeResult.judgements) {
        if (!eligibleBranches.has(j.candidate_branch)) continue;

        if (!scores.has(j.candidate_branch)) {
          scores.set(j.candidate_branch, { total: 0, count: 0, breakdown: [] });
        }

        let weight = 1.0;
        // Downweight self-score
        // j.judge_preset is the agent ID of the judge
        // We need to know who created the candidate branch. 
        // branch naming convention: pangloss/<run_id>/<agent_id>
        // We can extract agent_id from branch name
        const candidateAgentId = this.extractAgentIdFromBranch(j.candidate_branch);
        
        if (candidateAgentId === j.judge_preset) {
          weight = 0.5;
        }

        const weightedScore = j.overall_score * weight;
        const entry = scores.get(j.candidate_branch)!;
        entry.total += weightedScore;
        entry.count += weight; // Normalize by weight sum? Or just sum?
        // Plan says: "compute weighted average score"
        entry.breakdown.push({ judge: j.judge_preset, score: j.overall_score, weight });
      }
    }

    // 3. Calculate final scores and rank
    let bestBranch = '';
    let maxScore = -1;

    for (const [branch, data] of scores.entries()) {
      const avgScore = data.count > 0 ? data.total / data.count : 0;
      
      // Tie-breaker: E2E tests passed
      const genResult = branchToGenResult.get(branch);
      const e2ePassed = genResult?.test_results?.e2e_passed || 0;
      
      // Composite score: Avg Score + (E2E passed * 0.1 bonus)? 
      // Plan says: "Tie-breaker: prefer candidate with more passing E2E tests, then faster execution time."
      
      if (avgScore > maxScore) {
        maxScore = avgScore;
        bestBranch = branch;
      } else if (Math.abs(avgScore - maxScore) < 0.1) {
        // Tie logic
        const currentBestGen = branchToGenResult.get(bestBranch);
        const currentE2E = currentBestGen?.test_results?.e2e_passed || 0;
        
        if (e2ePassed > currentE2E) {
          bestBranch = branch;
          maxScore = avgScore;
        }
      }
    }

    if (!bestBranch) {
        // Fallback: pick the first eligible one if no judgements?
        // Or pick one with most tests passed
        return this.fallbackSelection(eligibleBranches, branchToGenResult);
    }

    // 4. Consolidate recommendations for the winner
    const recommendations = this.consolidateRecommendations(bestBranch, judgements);

    return {
      winner_branch: bestBranch,
      winner_agent_id: this.extractAgentIdFromBranch(bestBranch),
      score: maxScore,
      consolidated_recommendations: recommendations,
      reason: `Highest weighted score (${maxScore.toFixed(2)})`
    };
  }

  private extractAgentIdFromBranch(branch: string): string {
    // pangloss/<run_id>/<agent_id>
    const parts = branch.split('/');
    return parts.length >= 3 ? parts[parts.length - 1] : 'unknown';
  }

  private fallbackSelection(eligibleBranches: Set<string>, branchMap: Map<string, AgentResult>): WinnerSelection | null {
      let bestBranch = '';
      let maxTests = -1;

      for (const branch of eligibleBranches) {
          const res = branchMap.get(branch)!;
          const passed = (res.test_results?.passed || 0) + (res.test_results?.e2e_passed || 0);
          if (passed > maxTests) {
              maxTests = passed;
              bestBranch = branch;
          }
      }

      if (!bestBranch) return null;

      return {
          winner_branch: bestBranch,
          winner_agent_id: this.extractAgentIdFromBranch(bestBranch),
          score: 0,
          consolidated_recommendations: [],
          reason: 'Fallback: most passing tests'
      };
  }

  private consolidateRecommendations(winnerBranch: string, judgements: AgentResult[]): string[] {
      const allRecs = new Set<string>();
      
      for (const jRes of judgements) {
          if (!jRes.judgements) continue;
          for (const j of jRes.judgements) {
              if (j.candidate_branch === winnerBranch) {
                  j.recommendations.must_fix.forEach(r => allRecs.add(r));
                  // Optionally include high-value nice_to_haves? Plan says "Apply must_fix items"
              }
          }
      }
      
      // Simple deduplication is handled by Set. 
      // A more advanced semantic dedup would need an LLM call, but that's overkill for v1 code.
      return Array.from(allRecs);
  }
}
