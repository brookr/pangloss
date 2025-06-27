#!/usr/bin/env node

import { spawn } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

class AgentRunner {
  constructor() {
    this.agentId = process.env.AGENT_ID;
    this.repoUrl = process.env.REPO_URL;
    this.featureName = process.env.FEATURE_NAME;
    this.branchName = process.env.BRANCH_NAME;
    this.llmProvider = process.env.LLM_PROVIDER;
    this.llmModel = process.env.LLM_MODEL;
    this.cliModel = process.env.CLI_MODEL || this.llmModel;
    this.requestPrompt = process.env.REQUEST_PROMPT;
    this.githubToken = process.env.GITHUB_TOKEN;
    this.timeoutMinutes = parseInt(process.env.TIMEOUT_MINUTES || '15');
    
    this.workspaceDir = '/workspace';
    this.resultsDir = `/results/${this.agentId}`;
    this.startTime = Date.now();
  }

  async run() {
    try {
      console.log(`🤖 Agent ${this.agentId} starting...`);
      
      // Create results directory
      await mkdir(this.resultsDir, { recursive: true });
      
      // Clone repository
      await this.cloneRepository();
      
      // Generate code using CLI tool
      await this.generateCodeWithCLI();
      
      // Get list of changed files
      const changedFiles = await this.getChangedFiles();
      
      // Run tests and validation
      const testResults = await this.runTests();
      const buildStatus = await this.runBuild();
      const playwrightResults = await this.runPlaywright();
      
      // Calculate metrics
      const metrics = await this.calculateMetrics(changedFiles);
      
      // Commit and push changes
      await this.commitAndPush();
      
      // Write results
      const result = {
        agent_id: this.agentId,
        branch_name: this.branchName,
        success: true,
        changes_made: changedFiles,
        test_results: testResults,
        build_status: buildStatus,
        playwright_results: playwrightResults,
        metrics: {
          ...metrics,
          execution_time_ms: Date.now() - this.startTime
        }
      };
      
      await this.writeResult(result);
      console.log(`✅ Agent ${this.agentId} completed successfully`);
      
    } catch (error) {
      console.error(`❌ Agent ${this.agentId} failed:`, error);
      
      const result = {
        agent_id: this.agentId,
        branch_name: this.branchName,
        success: false,
        changes_made: [],
        build_status: 'failed',
        metrics: {
          files_changed: 0,
          lines_added: 0,
          lines_removed: 0,
          complexity_score: 0,
          quality_score: 0,
          execution_time_ms: Date.now() - this.startTime
        },
        error: error.message
      };
      
      await this.writeResult(result);
    }
  }

  async cloneRepository() {
    return new Promise((resolve, reject) => {
      const gitProcess = spawn('git', [
        'clone', this.repoUrl, this.workspaceDir
      ]);

      gitProcess.on('close', (code) => {
        if (code === 0) {
          // Create and checkout branch
          const branchProcess = spawn('git', [
            'checkout', '-b', this.branchName
          ], { cwd: this.workspaceDir });

          branchProcess.on('close', (branchCode) => {
            if (branchCode === 0) {
              resolve();
            } else {
              reject(new Error(`Failed to create branch ${this.branchName}`));
            }
          });
        } else {
          reject(new Error('Failed to clone repository'));
        }
      });
    });
  }

  async generateCodeWithCLI() {
    const fullPrompt = `${this.requestPrompt}

Please implement the requested feature by making the necessary code changes. Work directly in the codebase and make all required modifications.`;

    let cliCommand;
    let cliArgs;

    switch (this.llmProvider) {
      case 'openai':
        cliCommand = 'codex';
        cliArgs = [
          '--model', this.cliModel,
          '--approval-mode', 'full-auto',
          '--quiet',
          '--prompt', fullPrompt
        ];
        break;
        
      case 'anthropic':
        cliCommand = 'claude';
        cliArgs = [
          '--model', this.cliModel,
          '--output-format', 'stream-json',
          '-p', fullPrompt
        ];
        break;
        
      case 'google':
        cliCommand = 'gemini';
        cliArgs = [
          '--model', this.cliModel,
          '--prompt', fullPrompt
        ];
        break;
        
      default:
        throw new Error(`Unsupported LLM provider: ${this.llmProvider}`);
    }

    return new Promise((resolve, reject) => {
      console.log(`Running: ${cliCommand} ${cliArgs.join(' ')}`);
      
      const cliProcess = spawn(cliCommand, cliArgs, {
        cwd: this.workspaceDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.timeoutMinutes * 60 * 1000
      });

      let stdout = '';
      let stderr = '';

      cliProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
        process.stdout.write(data);
      });

      cliProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
        process.stderr.write(data);
      });

      cliProcess.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ ${cliCommand} completed successfully`);
          resolve();
        } else {
          reject(new Error(`${cliCommand} failed with code ${code}\n${stderr}`));
        }
      });

      cliProcess.on('error', (error) => {
        reject(new Error(`Failed to start ${cliCommand}: ${error.message}`));
      });
    });
  }

  async getChangedFiles() {
    try {
      const result = await this.runCommand(['git', 'diff', '--name-only', 'HEAD']);
      const untracked = await this.runCommand(['git', 'ls-files', '--others', '--exclude-standard']);
      
      const changed = result.stdout.trim().split('\n').filter(f => f.length > 0);
      const untrackedFiles = untracked.stdout.trim().split('\n').filter(f => f.length > 0);
      
      return [...changed, ...untrackedFiles];
    } catch (error) {
      return [];
    }
  }

  async runTests() {
    // Try to detect and run the appropriate test command
    const testCommands = ['npm test', 'yarn test', 'pytest', 'go test', 'cargo test'];
    
    for (const command of testCommands) {
      try {
        const result = await this.runCommand(command.split(' '));
        if (result.exitCode === 0) {
          return this.parseTestResults(result.stdout);
        }
      } catch (error) {
        // Continue to next test command
      }
    }

    return { passed: 0, failed: 0, total: 0, duration_ms: 0 };
  }

  async runBuild() {
    const buildCommands = ['npm run build', 'yarn build', 'tsc', 'go build', 'cargo build'];
    
    for (const command of buildCommands) {
      try {
        const result = await this.runCommand(command.split(' '));
        if (result.exitCode === 0) {
          return 'success';
        }
      } catch (error) {
        // Continue to next build command
      }
    }

    return 'failed';
  }

  async runPlaywright() {
    try {
      const result = await this.runCommand(['npx', 'playwright', 'test']);
      return this.parsePlaywrightResults(result.stdout);
    } catch (error) {
      return { passed: 0, failed: 0, total: 0, screenshots: [], duration_ms: 0 };
    }
  }

  async runCommand(command) {
    return new Promise((resolve) => {
      const process = spawn(command[0], command.slice(1), {
        cwd: this.workspaceDir,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      process.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        resolve({
          exitCode: code,
          stdout,
          stderr
        });
      });
    });
  }

  parseTestResults(output) {
    // Simple parsing - would need to be more sophisticated for different test frameworks
    const passed = (output.match(/(\d+) passing/i) || [0, 0])[1];
    const failed = (output.match(/(\d+) failing/i) || [0, 0])[1];
    
    return {
      passed: parseInt(passed),
      failed: parseInt(failed),
      total: parseInt(passed) + parseInt(failed),
      duration_ms: 0 // Would need to parse timing info
    };
  }

  parsePlaywrightResults(output) {
    // Parse Playwright test results
    const passed = (output.match(/(\d+) passed/i) || [0, 0])[1];
    const failed = (output.match(/(\d+) failed/i) || [0, 0])[1];
    
    return {
      passed: parseInt(passed),
      failed: parseInt(failed),
      total: parseInt(passed) + parseInt(failed),
      screenshots: [], // Would need to collect actual screenshots
      duration_ms: 0
    };
  }

  async calculateMetrics(changedFiles) {
    const metrics = {
      files_changed: changedFiles.length,
      lines_added: 0,
      lines_removed: 0,
      complexity_score: 0,
      quality_score: 0
    };

    // Calculate git diff stats
    try {
      const diffResult = await this.runCommand(['git', 'diff', '--numstat', 'HEAD']);
      const lines = diffResult.stdout.trim().split('\n');
      
      for (const line of lines) {
        const [added, removed] = line.split('\t');
        if (added !== '-') metrics.lines_added += parseInt(added);
        if (removed !== '-') metrics.lines_removed += parseInt(removed);
      }
    } catch (error) {
      // If git diff fails, use file count as approximation
      metrics.lines_added = changedFiles.length * 10;
    }

    // Simple quality score based on successful tests and builds
    metrics.quality_score = Math.min(100, (metrics.lines_added + metrics.lines_removed) / 10);

    return metrics;
  }

  async commitAndPush() {
    // Add changes
    await this.runCommand(['git', 'add', '.']);
    
    // Commit changes
    const commitMessage = `feat: ${this.featureName}\n\nGenerated by ${this.agentId} agent`;
    await this.runCommand(['git', 'commit', '-m', commitMessage]);
    
    // Push to remote
    await this.runCommand(['git', 'push', 'origin', this.branchName]);
  }

  async writeResult(result) {
    const resultPath = join(this.resultsDir, 'result.json');
    await writeFile(resultPath, JSON.stringify(result, null, 2));
  }
}

// Run the agent
const agent = new AgentRunner();
agent.run().catch(console.error);