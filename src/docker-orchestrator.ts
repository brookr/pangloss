import { spawn } from 'child_process';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import YAML from 'yaml';
import { PanglossConfig, AgentRequest, AgentResult } from './types.js';

export class DockerOrchestrator {
  private config: PanglossConfig;
  private workspaceDir: string;

  constructor(config: PanglossConfig) {
    this.config = config;
    this.workspaceDir = join(process.cwd(), '.pangloss');
  }

  async runAgents(requests: AgentRequest[], timeoutMinutes: number): Promise<AgentResult[]> {
    // Ensure workspace exists
    if (!existsSync(this.workspaceDir)) {
      await mkdir(this.workspaceDir, { recursive: true });
    }

    // Generate docker-compose.yml
    const composeConfig = this.generateDockerCompose(requests, timeoutMinutes);
    const composePath = join(this.workspaceDir, 'docker-compose.yml');
    await writeFile(composePath, YAML.stringify(composeConfig));

    // Generate environment file
    await this.generateEnvFile(requests);

    // Run docker-compose
    return this.executeDockerCompose(requests);
  }

  private generateDockerCompose(requests: AgentRequest[], timeoutMinutes: number) {
    const services: Record<string, any> = {};

    requests.forEach((request, index) => {
      const agentId = request.llm_preset.provider;
      services[`agent-${index}`] = {
        image: 'pangloss/agent:latest',
        build: {
          context: '.',
          dockerfile: 'agent.Dockerfile'
        },
        environment: [
          `AGENT_ID=${agentId}`,
          `REPO_URL=${request.repo_url}`,
          `FEATURE_NAME=${request.feature_name}`,
          `BRANCH_NAME=${request.branch_name}`,
          `LLM_PROVIDER=${request.llm_preset.provider}`,
          `LLM_MODEL=${request.llm_preset.model}`,
          `CLI_MODEL=${request.llm_preset.cli_model || ''}`,
          `LLM_TEMPERATURE=${request.llm_preset.temperature}`,
          `LLM_MAX_TOKENS=${request.llm_preset.max_tokens || 4000}`,
          `SYSTEM_PROMPT=${request.llm_preset.system_prompt || ''}`,
          `REQUEST_PROMPT=${request.request_prompt}`,
          `GITHUB_TOKEN=${request.github_token}`,
          `TIMEOUT_MINUTES=${timeoutMinutes}`
        ],
        volumes: [
          `${this.workspaceDir}/results:/results`,
          `${this.workspaceDir}/ssh:/root/.ssh:ro`
        ],
        working_dir: '/app',
        command: ['node', 'agent-runner.js'],
        restart: 'no'
      };
    });

    return {
      version: '3.8',
      services
    };
  }

  private async generateEnvFile(requests: AgentRequest[]): Promise<void> {
    const envVars = [
      `GITHUB_TOKEN=${requests[0]?.github_token || process.env.GITHUB_TOKEN || ''}`,
      `OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''}`,
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ''}`,
      `GOOGLE_API_KEY=${process.env.GOOGLE_API_KEY || ''}`
    ];

    await writeFile(join(this.workspaceDir, '.env'), envVars.join('\n'));
  }

  private async executeDockerCompose(requests: AgentRequest[]): Promise<AgentResult[]> {
    return new Promise((resolve, reject) => {
      const dockerProcess = spawn('docker-compose', [
        '-f', join(this.workspaceDir, 'docker-compose.yml'),
        'up', '--build'
      ], {
        cwd: this.workspaceDir,
        stdio: ['inherit', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      dockerProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        process.stdout.write(data);
      });

      dockerProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        process.stderr.write(data);
      });

      dockerProcess.on('close', async (code) => {
        if (code === 0) {
          try {
            const results = await this.collectResults(requests);
            resolve(results);
          } catch (error) {
            reject(error);
          }
        } else {
          reject(new Error(`Docker compose failed with code ${code}\n${stderr}`));
        }
      });
    });
  }

  private async collectResults(requests: AgentRequest[]): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    const resultsDir = join(this.workspaceDir, 'results');

    for (let i = 0; i < requests.length; i++) {
      const agentResultPath = join(resultsDir, `agent-${i}`, 'result.json');
      
      try {
        if (existsSync(agentResultPath)) {
          const resultContent = await readFile(agentResultPath, 'utf-8');
          const result: AgentResult = JSON.parse(resultContent);
          results.push(result);
        } else {
          // Agent didn't complete - create failed result
          results.push({
            agent_id: requests[i].llm_preset.provider,
            branch_name: requests[i].branch_name,
            success: false,
            changes_made: [],
            build_status: 'not_run',
            metrics: {
              files_changed: 0,
              lines_added: 0,
              lines_removed: 0,
              complexity_score: 0,
              quality_score: 0,
              execution_time_ms: 0
            },
            error: 'Agent did not complete execution'
          });
        }
      } catch (error) {
        results.push({
          agent_id: requests[i].llm_preset.provider,
          branch_name: requests[i].branch_name,
          success: false,
          changes_made: [],
          build_status: 'not_run',
          metrics: {
            files_changed: 0,
            lines_added: 0,
            lines_removed: 0,
            complexity_score: 0,
            quality_score: 0,
            execution_time_ms: 0
          },
          error: `Failed to read result: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }
    }

    return results;
  }
}