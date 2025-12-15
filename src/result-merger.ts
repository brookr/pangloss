import { spawn } from 'child_process';
import { AgentResult, MergeStrategy } from './types.js';

export class ResultMerger {
  private static readonly DEFAULT_WORKSPACE_DIR = 'final-workspace';

  async mergeBestSolutions(
    results: AgentResult[],
    finalBranch: string,
    strategy: MergeStrategy,
    repoUrl: string
  ): Promise<void> {
    // Score and rank results
    const rankedResults = this.rankResults(results, strategy);
    
    // Clone repo and create final branch
    await this.setupFinalBranch(repoUrl, finalBranch);
    
    // Apply merge strategy
    switch (strategy.type) {
      case 'best_overall':
        await this.mergeBestOverall(rankedResults[0]);
        break;
      case 'best_per_file':
        await this.mergeBestPerFile(rankedResults);
        break;
      case 'composite':
        await this.mergeComposite(rankedResults);
        break;
    }
    
    // Push final branch
    await this.pushBranch(finalBranch);
  }

  private rankResults(
    results: AgentResult[],
    strategy: MergeStrategy
  ): Array<AgentResult & { composite_score: number }> {
    return results
      .map((result) => ({
        ...result,
        composite_score: this.calculateCompositeScore(result, strategy.weights)
      }))
      .sort((a, b) => b.composite_score - a.composite_score);
  }

  private calculateCompositeScore(
    result: AgentResult,
    weights: MergeStrategy['weights']
  ): number {
    const testScore = result.test_results 
      ? (result.test_results.passed / result.test_results.total) 
      : 0;
    
    const buildScore = result.build_status === 'success' ? 1 : 0;
    const qualityScore = result.metrics.quality_score / 100; // Assuming 0-100 scale
    const performanceScore = Math.min(1, 10000 / result.metrics.execution_time_ms); // Faster is better
    
    return (
      testScore * weights.test_success +
      qualityScore * weights.code_quality +
      performanceScore * weights.performance +
      buildScore * 0.1 // Small bonus for successful builds
    );
  }

  private async setupFinalBranch(repoUrl: string, finalBranch: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const gitProcess = spawn('git', [
        'clone', repoUrl, ResultMerger.DEFAULT_WORKSPACE_DIR
      ]);

      gitProcess.on('close', (code) => {
        if (code === 0) {
          // Create and checkout final branch
          const branchProcess = spawn('git', [
            'checkout', '-b', finalBranch
          ], { cwd: ResultMerger.DEFAULT_WORKSPACE_DIR });

          branchProcess.on('close', (branchCode) => {
            if (branchCode === 0) {
              resolve();
            } else {
              reject(new Error(`Failed to create branch ${finalBranch}`));
            }
          });
        } else {
          reject(new Error(`Failed to clone repository`));
        }
      });
    });
  }

  private async mergeBestOverall(
    bestResult: AgentResult
  ): Promise<void> {
    // Simple strategy: merge the entire best branch
    return new Promise((resolve, reject) => {
      const mergeProcess = spawn('git', [
        'merge', bestResult.branch_name, '--no-ff'
      ], { cwd: ResultMerger.DEFAULT_WORKSPACE_DIR });

      mergeProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          // Handle merge conflicts by taking the incoming changes
          const resolveProcess = spawn('git', [
            'checkout', '--theirs', '.'
          ], { cwd: ResultMerger.DEFAULT_WORKSPACE_DIR });

          resolveProcess.on('close', () => {
            const commitProcess = spawn('git', [
              'commit', '-m', `Merge best solution from ${bestResult.agent_id}`
            ], { cwd: ResultMerger.DEFAULT_WORKSPACE_DIR });

            commitProcess.on('close', (commitCode) => {
              if (commitCode === 0) {
                resolve();
              } else {
                reject(new Error('Failed to resolve merge conflicts'));
              }
            });
          });
        }
      });
    });
  }

  private async mergeBestPerFile(
    rankedResults: AgentResult[]
  ): Promise<void> {
    // More complex: analyze each file and take the best version
    // This would require more sophisticated diff analysis
    // For now, fall back to best overall
    await this.mergeBestOverall(rankedResults[0]);
  }

  private async mergeComposite(
    rankedResults: AgentResult[]
  ): Promise<void> {
    // Advanced: combine different aspects from different solutions
    // This would require semantic code analysis
    // For now, fall back to best overall
    await this.mergeBestOverall(rankedResults[0]);
  }

  private async pushBranch(finalBranch: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const pushProcess = spawn('git', [
        'push', 'origin', finalBranch
      ], { cwd: ResultMerger.DEFAULT_WORKSPACE_DIR });

      pushProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Failed to push branch ${finalBranch}`));
        }
      });
    });
  }
}