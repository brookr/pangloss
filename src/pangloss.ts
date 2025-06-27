import { spawn } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { PanglossConfig, AgentRequest, AgentResult, MergeStrategy } from './types.js';
import { DockerOrchestrator } from './docker-orchestrator.js';
import { ResultMerger } from './result-merger.js';

export interface GenerateOptions {
  repo_url: string;
  feature_name: string;
  request_prompt: string;
  agents: string[];
  timeout_minutes: number;
  merge_strategy: string;
}

export interface GenerateResult {
  success: boolean;
  final_branch?: string;
  pr_url?: string;
  agent_results: AgentResult[];
  error?: string;
}

export class Pangloss {
  private config: PanglossConfig;
  private orchestrator: DockerOrchestrator;
  private merger: ResultMerger;

  constructor(config: PanglossConfig) {
    this.config = config;
    this.orchestrator = new DockerOrchestrator(config);
    this.merger = new ResultMerger();
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const spinner = ora('Initializing Pangloss agents...').start();
    
    try {
      // Validate agents
      const invalidAgents = options.agents.filter(agent => !this.config.llm_presets[agent]);
      if (invalidAgents.length > 0) {
        throw new Error(`Invalid agents: ${invalidAgents.join(', ')}`);
      }

      // Extract repo name from URL
      const repoName = this.extractRepoName(options.repo_url);
      
      // Create agent requests
      const agentRequests: AgentRequest[] = options.agents.map(agentId => ({
        repo_url: options.repo_url,
        feature_name: options.feature_name,
        branch_name: `${repoName}/${options.feature_name}/${agentId}`,
        llm_preset: this.config.llm_presets[agentId],
        request_prompt: options.request_prompt,
        github_token: process.env.GITHUB_TOKEN || this.config.github_token || ''
      }));

      spinner.text = `Spawning ${options.agents.length} agents in parallel...`;
      
      // Run agents in parallel
      const agentResults = await this.orchestrator.runAgents(
        agentRequests, 
        options.timeout_minutes
      );

      spinner.succeed(`Completed ${agentResults.length} agent runs`);

      // Display results
      this.displayAgentResults(agentResults);

      // Filter successful results
      const successfulResults = agentResults.filter(result => result.success);
      
      if (successfulResults.length === 0) {
        return {
          success: false,
          agent_results: agentResults,
          error: 'No agents completed successfully'
        };
      }

      // Merge results
      const mergeSpinner = ora('Merging best solutions...').start();
      
      const mergeStrategy: MergeStrategy = {
        type: options.merge_strategy as any,
        weights: {
          test_success: 0.4,
          code_quality: 0.3,
          performance: 0.2,
          coverage: 0.1
        }
      };

      const finalBranch = `${repoName}/${options.feature_name}/final`;
      
      await this.merger.mergeBestSolutions(
        successfulResults,
        finalBranch,
        mergeStrategy,
        options.repo_url
      );

      mergeSpinner.succeed('Solutions merged successfully');

      // Create PR (optional)
      const prUrl = await this.createPullRequest(
        options.repo_url,
        finalBranch,
        options.feature_name,
        successfulResults
      );

      return {
        success: true,
        final_branch: finalBranch,
        pr_url: prUrl,
        agent_results: agentResults
      };

    } catch (error) {
      spinner.fail('Generation failed');
      return {
        success: false,
        agent_results: [],
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private extractRepoName(repoUrl: string): string {
    const match = repoUrl.match(/github\.com\/[^\/]+\/([^\/\.]+)/);
    return match ? match[1] : 'unknown-repo';
  }

  private displayAgentResults(results: AgentResult[]): void {
    console.log(chalk.cyan('\n📊 Agent Results:'));
    
    results.forEach(result => {
      const status = result.success ? chalk.green('✅') : chalk.red('❌');
      const metrics = result.metrics;
      
      console.log(`\n${status} ${chalk.bold(result.agent_id)}`);
      console.log(`   Branch: ${chalk.gray(result.branch_name)}`);
      
      if (result.success) {
        console.log(`   Files: ${metrics.files_changed}, Lines: +${metrics.lines_added}/-${metrics.lines_removed}`);
        console.log(`   Build: ${result.build_status}, Tests: ${result.test_results?.passed || 0}/${result.test_results?.total || 0}`);
        console.log(`   Quality: ${metrics.quality_score.toFixed(2)}, Time: ${(metrics.execution_time_ms / 1000).toFixed(1)}s`);
      } else {
        console.log(`   Error: ${chalk.red(result.error || 'Unknown error')}`);
      }
    });
  }

  private async createPullRequest(
    repoUrl: string, 
    branchName: string, 
    featureName: string,
    agentResults: AgentResult[]
  ): Promise<string | undefined> {
    try {
      const [owner, repo] = this.extractOwnerRepo(repoUrl);
      
      const prTitle = `feat: ${featureName}`;
      const prBody = this.generatePRDescription(featureName, agentResults);
      
      // Use GitHub CLI to create PR
      return new Promise((resolve, reject) => {
        const ghProcess = spawn('gh', [
          'pr', 'create',
          '--repo', `${owner}/${repo}`,
          '--head', branchName,
          '--title', prTitle,
          '--body', prBody
        ]);
        
        let output = '';
        ghProcess.stdout.on('data', (data) => {
          output += data.toString();
        });
        
        ghProcess.on('close', (code) => {
          if (code === 0) {
            const prUrl = output.trim();
            resolve(prUrl);
          } else {
            console.warn('Could not create PR automatically');
            resolve(undefined);
          }
        });
      });
    } catch (error) {
      console.warn('Could not create PR:', error);
      return undefined;
    }
  }

  private extractOwnerRepo(repoUrl: string): [string, string] {
    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
    return match ? [match[1], match[2]] : ['', ''];
  }

  private generatePRDescription(featureName: string, agentResults: AgentResult[]): string {
    const successfulAgents = agentResults.filter(r => r.success);
    
    return `## ${featureName}

Generated using Pangloss with ${agentResults.length} parallel LLM agents.

### Agent Results:
${successfulAgents.map(agent => 
  `- **${agent.agent_id}**: ${agent.metrics.files_changed} files, +${agent.metrics.lines_added}/-${agent.metrics.lines_removed} lines`
).join('\n')}

### Merged Solution:
This PR contains the optimal combination of solutions from the successful agents above.

**Tests**: ${successfulAgents.reduce((sum, a) => sum + (a.test_results?.passed || 0), 0)} passing
**Build**: All agents built successfully
**Quality Score**: ${(successfulAgents.reduce((sum, a) => sum + a.metrics.quality_score, 0) / successfulAgents.length).toFixed(2)}

---
*Generated by Pangloss - finding the best of all possible solutions*`;
  }
}