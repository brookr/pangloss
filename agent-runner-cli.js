#!/usr/bin/env node

import { spawn } from 'child_process';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

class CLIAgentRunner {
  constructor() {
    this.agentId = process.env.AGENT_ID;
    this.repoUrl = process.env.REPO_URL;
    this.featureName = process.env.FEATURE_NAME;
    this.branchName = process.env.BRANCH_NAME;
    this.llmProvider = process.env.LLM_PROVIDER;
    this.llmModel = process.env.LLM_MODEL;
    this.cliModel = process.env.CLI_MODEL;
    this.requestPrompt = process.env.REQUEST_PROMPT;
    this.githubToken = process.env.GITHUB_TOKEN;
    this.timeoutMinutes = parseInt(process.env.TIMEOUT_MINUTES || '15');
    
    this.workspaceDir = '/workspace';
    this.resultsDir = `/results/${this.agentId}`;
    this.startTime = Date.now();
  }

  async run() {
    try {
      console.log(`🤖 Agent ${this.agentId} starting with ${this.llmProvider} CLI...`);
      
      // Create results directory
      await mkdir(this.resultsDir, { recursive: true });
      
      // Clone repository
      await this.cloneRepository();
      
      // Generate code using appropriate CLI tool
      const changedFiles = await this.generateCodeWithCLI();
      
      // Run tests and validation
      const testResults = await this.runTests();
      const buildStatus = await this.runBuild();
      const playwrightResults = await this.runPlaywright();
      
      // Calculate metrics
      const metrics = await this.calculateMetrics(changedFiles);
      
      // Commit and push changes
      await this.commitAndPush(changedFiles);
      
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
    const changedFiles = [];
    
    switch (this.llmProvider) {
      case 'openai':
        changedFiles.push(...await this.runCodexCLI());
        break;
      case 'anthropic':
        changedFiles.push(...await this.runClaudeCodeCLI());
        break;
      case 'google':
        changedFiles.push(...await this.runGeminiCLI());
        break;
      default:
        throw new Error(`Unsupported LLM provider: ${this.llmProvider}`);
    }
    
    return changedFiles;
  }

  async runCodexCLI() {
    console.log(`🔧 Running OpenAI Codex CLI with ${this.cliModel || 'default model'}...`);
    
    // Use Codex CLI with FULL-AUTO mode for complete automation
    const codePrompt = `${this.requestPrompt}

Please implement this feature in the current codebase. Make all necessary changes to files and ensure the implementation is complete and well-tested.`;

    const command = [
      'codex',
      '--approval-mode', 'full-auto',  // Fully automated mode
      '--quiet',  // Non-interactive quiet mode for automation
      '--prompt', codePrompt
    ];

    // Add model specification if provided
    if (this.cliModel) {
      command.splice(-1, 0, '--model', this.cliModel);
    }

    const result = await this.runCommand(command);

    if (result.exitCode !== 0) {
      throw new Error(`Codex CLI failed: ${result.stderr}`);
    }

    // Get list of modified files from git
    return await this.getModifiedFiles();
  }

  async runClaudeCodeCLI() {
    console.log(`🔧 Running Claude Code CLI with ${this.cliModel || 'default model'}...`);
    
    // Use Claude Code CLI in headless mode for automation
    const codePrompt = `${this.requestPrompt}

Please implement this feature in the current codebase. Make all necessary changes to files, run tests to ensure everything works, and commit the changes.`;

    const command = [
      'claude',
      '-p', codePrompt,
      '--output-format', 'stream-json'  // For better automation
    ];

    // Add model specification if provided
    if (this.cliModel) {
      command.splice(-2, 0, '--model', this.cliModel);
    }

    const result = await this.runCommand(command);

    if (result.exitCode !== 0) {
      throw new Error(`Claude Code CLI failed: ${result.stderr}`);
    }

    // Get list of modified files from git
    return await this.getModifiedFiles();
  }

  async runGeminiCLI() {
    console.log(`🔧 Running Gemini CLI with ${this.cliModel || 'default model'}...`);
    
    // Use Gemini CLI with prompt flag for non-interactive execution
    const codePrompt = `${this.requestPrompt}

Please implement this feature in the current codebase. Analyze the existing code structure, make all necessary changes to files, and ensure the implementation follows the project's patterns and conventions.`;

    const command = [
      'gemini',
      '--prompt', codePrompt  // Use --prompt flag for non-interactive mode
    ];

    // Add model specification if provided (note: may need adjustment based on actual Gemini CLI syntax)
    if (this.cliModel) {
      command.splice(-1, 0, '--model', this.cliModel);
    }

    const result = await this.runCommand(command);

    if (result.exitCode !== 0) {
      throw new Error(`Gemini CLI failed: ${result.stderr}`);
    }

    // Get list of modified files from git
    return await this.getModifiedFiles();
  }

  async getModifiedFiles() {
    const result = await this.runCommand(['git', 'diff', '--name-only']);
    if (result.exitCode === 0) {
      return result.stdout.trim().split('\n').filter(f => f.length > 0);
    }
    return [];
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
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
          GITHUB_TOKEN: this.githubToken
        }
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        resolve({
          exitCode: code,
          stdout,
          stderr
        });
      });

      // Set timeout
      setTimeout(() => {
        process.kill('SIGTERM');
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + '\nProcess terminated due to timeout'
        });
      }, this.timeoutMinutes * 60 * 1000);
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

  async commitAndPush(changedFiles) {
    // Add changes
    await this.runCommand(['git', 'add', '.']);
    
    // Commit changes
    const commitMessage = `feat: ${this.featureName}\n\nGenerated by ${this.agentId} CLI agent using ${this.llmProvider}`;
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
const agent = new CLIAgentRunner();
agent.run().catch(console.error);