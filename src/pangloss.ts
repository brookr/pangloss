import { spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { v4 as uuidv4 } from 'uuid';
import { PanglossConfig, AgentRequest, AgentResult, PanglossPlan } from './types.js';
import { DockerOrchestrator } from './docker-orchestrator.js';
import { ResultAggregator } from './result-aggregator.js';

export interface RunOptions {
  run_id?: string;
  repo_url: string;
  base_branch: string;
  plan: PanglossPlan;
  agents: string[];
  timeout_minutes: number;
  keep_branches?: boolean;
}

export interface RunResult {
  success: boolean;
  run_id: string;
  agent_results: AgentResult[];
  error?: string;
}

export class Pangloss {
  private config: PanglossConfig;
  private orchestrator: DockerOrchestrator;
  private aggregator: ResultAggregator;

  constructor(config: PanglossConfig) {
    this.config = config;
    this.orchestrator = new DockerOrchestrator(config);
    this.aggregator = new ResultAggregator();
  }

  async execute(options: RunOptions): Promise<RunResult> {
    const runId = options.run_id || this.generateRunId();
    console.log(chalk.blue(`\n🚀 Starting Pangloss Run: ${runId}`));
    
    try {
      // Validate agents
      const invalidAgents = options.agents.filter(agent => !this.config.llm_presets[agent]);
      if (invalidAgents.length > 0) {
        throw new Error(`Invalid agents: ${invalidAgents.join(', ')}`);
      }

      // 1. GENERATE PHASE
      const genSpinner = ora('Phase 1/4: Generating solutions...').start();
      
      const genRequests: AgentRequest[] = options.agents.map(agentId => {
        const preset = this.config.llm_presets[agentId];
        return {
          run_id: runId,
          agent_preset_id: agentId,
          repo_url: options.repo_url,
          base_branch: options.base_branch,
          branch_name: `pangloss/${runId}/${agentId}`,
          mode: 'generate',
          llm_preset: preset,
          plan: options.plan,
          github_token: process.env.GITHUB_TOKEN || this.config.github_token || ''
        };
      });

      const genResults = await this.orchestrator.runAgents(genRequests, options.timeout_minutes);
      genSpinner.succeed(`Generation completed (${genResults.filter(r => r.success).length}/${genResults.length} success)`);
      this.displayAgentResults(genResults);

      // Check if any generation succeeded
      const successfulGenResults = genResults.filter(r => r.success && r.build_status === 'success');
      if (successfulGenResults.length === 0) {
        throw new Error('No agents successfully generated valid code (build failed or agent failed).');
      }

      // 2. JUDGE PHASE
      const judgeSpinner = ora('Phase 2/4: Judging solutions...').start();
      
      const candidateBranches = successfulGenResults.map(r => r.branch_name);
      
      const judgeRequests: AgentRequest[] = options.agents.map(agentId => {
        const preset = this.config.llm_presets[agentId];
        return {
          run_id: runId,
          agent_preset_id: agentId,
          repo_url: options.repo_url,
          base_branch: options.base_branch,
          branch_name: 'judge-runner', // Placeholder
          mode: 'judge',
          llm_preset: preset,
          plan: options.plan,
          github_token: process.env.GITHUB_TOKEN || this.config.github_token || '',
          candidate_branches: candidateBranches
        };
      });

      const judgeResults = await this.orchestrator.runAgents(judgeRequests, options.timeout_minutes);
      judgeSpinner.succeed('Judging completed');

      // 3. SELECTION & FINALIZATION PHASE
      const finalizeSpinner = ora('Phase 3/4: Selecting winner & finalizing...').start();
      
      const winner = this.aggregator.selectWinner(genResults, judgeResults);
      
      if (!winner) {
        throw new Error('Could not select a winner (no eligible candidates).');
      }

      finalizeSpinner.text = `Winner: ${winner.winner_agent_id} (${winner.reason}). Finalizing...`;
      
      // Finalize
      const winnerPreset = this.config.llm_presets[winner.winner_agent_id];
      const finalizeRequest: AgentRequest = {
          run_id: runId,
          agent_preset_id: winner.winner_agent_id,
          repo_url: options.repo_url,
          base_branch: options.base_branch,
          branch_name: winner.winner_branch,
          mode: 'finalize',
          llm_preset: winnerPreset,
          plan: options.plan,
          github_token: process.env.GITHUB_TOKEN || this.config.github_token || '',
          consolidated_recommendations: winner.consolidated_recommendations
      };

      const finalizeResults = await this.orchestrator.runAgents([finalizeRequest], options.timeout_minutes);
      const finalResult = finalizeResults[0];

      if (!finalResult.success) {
          finalizeSpinner.warn('Finalization step failed, falling back to pre-finalization state.');
      } else {
          finalizeSpinner.succeed('Finalization completed successfully.');
      }

      // 4. CLEANUP PHASE
      if (!options.keep_branches) {
        const cleanupSpinner = ora('Phase 4/4: Cleaning up branches...').start();
        try {
          const branchesToDelete = candidateBranches.filter(b => b !== winner.winner_branch);
          await this.cleanupBranches(branchesToDelete);
          cleanupSpinner.succeed(`Deleted ${branchesToDelete.length} non-winning branches`);
        } catch (e) {
          cleanupSpinner.warn(`Cleanup failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
      } else {
        console.log(chalk.gray('Phase 4/4: Cleanup skipped (branches kept for inspection)'));
      }

      return {
        success: finalResult.success,
        run_id: runId,
        agent_results: [...genResults, ...judgeResults, ...finalizeResults]
      };

    } catch (error) {
      console.error(chalk.red(`\n💥 Run failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
      return {
        success: false,
        run_id: runId,
        agent_results: [],
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async cleanupBranches(branches: string[]): Promise<void> {
    if (branches.length === 0) return;

    // Use git push origin --delete <branch>
    // We assume the local environment has credentials to push to remote
    // If not, we might need to rely on the agent container to do cleanup? 
    // Or assume the user has authenticated gh/git locally.
    
    // Construct the command
    // git push origin --delete branch1 branch2 ...
    // Note: This runs on the HOST machine.
    
    return new Promise((resolve, reject) => {
      const args = ['push', 'origin', '--delete', ...branches];
      const proc = spawn('git', args);
      
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());
      
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`git push delete failed: ${stderr}`));
      });
    });
  }

  private generateRunId(): string {
    const date = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHmmss
    const rand = uuidv4().slice(0, 4);
    return `${date}-${rand}`;
  }

  private displayAgentResults(results: AgentResult[]): void {
    console.log(chalk.cyan('\n📊 Phase Results:'));
    
    results.forEach(result => {
      const status = result.success ? chalk.green('✅') : chalk.red('❌');
      const metrics = result.metrics;
      
      console.log(`\n${status} ${chalk.bold(result.agent_id)}`);
      console.log(`   Branch: ${chalk.gray(result.branch_name)}`);
      
      if (result.success) {
        console.log(`   Files: ${metrics.files_changed}, Lines: +${metrics.lines_added}/-${metrics.lines_removed}`);
        if (result.mode === 'generate' || result.mode === 'finalize') {
            console.log(`   Build: ${result.build_status}, Tests: ${result.test_results?.passed || 0}/${result.test_results?.total || 0}`);
        }
        console.log(`   Time: ${(metrics.execution_time_ms / 1000).toFixed(1)}s`);
      } else {
        console.log(`   Error: ${chalk.red(result.error || 'Unknown error')}`);
      }
    });
  }
}