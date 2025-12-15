import { ResultAggregator } from '../src/result-aggregator.js';
import type { AgentJudgement, AgentResult, AgentMetrics, TestResults } from '../src/types.js';

describe('ResultAggregator.selectWinner', () => {
  it('selects the highest weighted-score branch and consolidates must-fix recommendations', () => {
    const runId = '20250101-000000-abcd';

    const codexBranch = `pangloss/${runId}/codex-o3`;
    const claudeBranch = `pangloss/${runId}/claude-sonnet`;

    const baseMetrics: AgentMetrics = {
      files_changed: 1,
      lines_added: 1,
      lines_removed: 0,
      complexity_score: 0,
      quality_score: 0,
      execution_time_ms: 1000
    };

    const baseTests: TestResults = {
      passed: 1,
      failed: 0,
      total: 1,
      duration_ms: 10,
      e2e_passed: 0,
      e2e_failed: 0
    };

    const genCodex: AgentResult = {
      run_id: runId,
      agent_id: 'codex-o3',
      branch_name: codexBranch,
      success: true,
      mode: 'generate',
      changes_made: [],
      test_results: baseTests,
      build_status: 'success',
      metrics: baseMetrics
    };

    const genClaude: AgentResult = {
      run_id: runId,
      agent_id: 'claude-sonnet',
      branch_name: claudeBranch,
      success: true,
      mode: 'generate',
      changes_made: [],
      test_results: baseTests,
      build_status: 'success',
      metrics: baseMetrics
    };

    const judgement = (
      candidate_branch: string,
      judge_preset: string,
      overall_score: number,
      must_fix: string[]
    ): AgentJudgement => ({
      candidate_branch,
      judge_preset,
      overall_score,
      sub_scores: {
        correctness: overall_score,
        completeness: overall_score,
        code_quality: overall_score,
        test_quality: overall_score,
        maintainability: overall_score
      },
      validation: {
        build_passed: true,
        unit_tests_passed: 1,
        unit_tests_failed: 0,
        e2e_tests_passed: 0,
        e2e_tests_failed: 0
      },
      recommendations: {
        must_fix,
        nice_to_have: []
      },
      confidence: 0.9,
      violation: false
    });

    // Two judge agents each score both candidates.
    // Self-scores are downweighted to 0.5 in ResultAggregator.
    const judgeCodex: AgentResult = {
      run_id: runId,
      agent_id: 'codex-o3',
      branch_name: 'judge-runner',
      success: true,
      mode: 'judge',
      changes_made: [],
      build_status: 'not_run',
      metrics: baseMetrics,
      judgements: [
        judgement(codexBranch, 'codex-o3', 10, ['fix-a']),
        judgement(claudeBranch, 'codex-o3', 5, [])
      ]
    };

    const judgeClaude: AgentResult = {
      run_id: runId,
      agent_id: 'claude-sonnet',
      branch_name: 'judge-runner',
      success: true,
      mode: 'judge',
      changes_made: [],
      build_status: 'not_run',
      metrics: baseMetrics,
      judgements: [
        judgement(codexBranch, 'claude-sonnet', 6, ['fix-b']),
        judgement(claudeBranch, 'claude-sonnet', 9, [])
      ]
    };

    const aggregator = new ResultAggregator();
    const winner = aggregator.selectWinner([genCodex, genClaude], [judgeCodex, judgeClaude]);

    expect(winner).not.toBeNull();
    expect(winner!.winner_branch).toBe(codexBranch);
    expect(winner!.winner_agent_id).toBe('codex-o3');
    expect(winner!.consolidated_recommendations).toEqual(expect.arrayContaining(['fix-a', 'fix-b']));
  });
});
