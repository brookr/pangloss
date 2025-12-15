import { spawn } from 'child_process';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
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
    const services: Record<string, unknown> = {};

    requests.forEach((request, index) => {
      const agentId = request.agent_preset_id;
      const serviceName = `agent-${index}`;
      
      // Host results path: .pangloss/runs/<run_id>/results/<mode>/<agent_id>
      const hostResultsDir = join(this.workspaceDir, 'runs', request.run_id, 'results', request.mode, agentId);
      
      services[serviceName] = {
        image: 'pangloss/agent:latest',
        build: {
          context: '..',
          dockerfile: 'agent.Dockerfile'
        },
        environment: [
          `RUN_ID=${request.run_id}`,
          `AGENT_ID=${agentId}`,
          `MODE=${request.mode}`,
          `REPO_URL=${request.repo_url}`,
          `BRANCH_NAME=${request.branch_name}`,
          `BASE_BRANCH=${request.base_branch}`,
          `LLM_PROVIDER=${request.llm_preset.provider}`,
          `LLM_MODEL=${request.llm_preset.model}`,
          `CLI_MODEL=${request.llm_preset.cli_model || ''}`,
          `LLM_TEMPERATURE=${request.llm_preset.temperature}`,
          `LLM_MAX_TOKENS=${request.llm_preset.max_tokens || 4000}`,
          `SYSTEM_PROMPT=${request.llm_preset.system_prompt || ''}`,
          `PLAN_CONTENT=${JSON.stringify(request.plan)}`,
          `CANDIDATE_BRANCHES=${request.candidate_branches ? JSON.stringify(request.candidate_branches) : ''}`,
          `CONSOLIDATED_RECOMMENDATIONS=${request.consolidated_recommendations ? JSON.stringify(request.consolidated_recommendations) : ''}`,
          `GITHUB_TOKEN=${request.github_token}`,
          `TIMEOUT_MINUTES=${timeoutMinutes}`,
          `OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''}`,
          `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ''}`,
          `GEMINI_API_KEY=${process.env.GEMINI_API_KEY || ''}`
        ],
        volumes: [
          `${hostResultsDir}:/results`,
          `${join(this.workspaceDir, 'ssh')}:/root/.ssh:ro`
        ],
        working_dir: '/app',
        command: ['node', 'agent-runner.js'],
        restart: 'no',
        deploy: {
          resources: {
            limits: {
              cpus: '4.0',
              memory: '2G'
            },
            reservations: {
              cpus: '1.0',
              memory: '512M'
            }
          }
        }
      };
    });

    return {
      services
    };
  }

  private async generateEnvFile(requests: AgentRequest[]): Promise<void> {
    const envVars = [
      `GITHUB_TOKEN=${requests[0]?.github_token || process.env.GITHUB_TOKEN || ''}`,
      `OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''}`,
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ''}`,
      `GEMINI_API_KEY=${process.env.GEMINI_API_KEY || ''}`
    ];

    await writeFile(join(this.workspaceDir, '.env'), envVars.join('\n'));
  }

  private async executeDockerCompose(requests: AgentRequest[]): Promise<AgentResult[]> {
    return new Promise((resolve, reject) => {
      // Ensure results directories exist
      const runId = requests[0].run_id;
      const setupPromise = Promise.all(requests.map(req => {
        const dir = join(this.workspaceDir, 'runs', runId, 'results', req.mode, req.agent_preset_id);
        return mkdir(dir, { recursive: true });
      }));

      setupPromise.then(() => {
        const dockerProcess = spawn('docker-compose', [
          '-f', join(this.workspaceDir, 'docker-compose.yml'),
          'up', '--build'
        ], {
          cwd: this.workspaceDir,
          stdio: ['inherit', 'pipe', 'pipe']
        });

        let stderr = '';

        dockerProcess.stdout.on('data', (data) => {
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
      }).catch(reject);
    });
  }

  private async collectResults(requests: AgentRequest[]): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    
    for (const request of requests) {
      const resultsDir = join(this.workspaceDir, 'runs', request.run_id, 'results', request.mode, request.agent_preset_id);
      const agentResultPath = join(resultsDir, 'result.json');
      
      try {
        if (existsSync(agentResultPath)) {
          const resultContent = await readFile(agentResultPath, 'utf-8');
          const result: AgentResult = JSON.parse(resultContent);
          results.push(result);
        } else {
          // Agent didn't complete - create failed result
          results.push({
            run_id: request.run_id,
            agent_id: request.agent_preset_id,
            branch_name: request.branch_name,
            mode: request.mode,
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
          run_id: request.run_id,
          agent_id: request.agent_preset_id,
          branch_name: request.branch_name,
          mode: request.mode,
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