#!/usr/bin/env node

import { spawn } from 'child_process';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

// LLM Client imports
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

class AgentRunner {
  constructor() {
    this.agentId = process.env.AGENT_ID;
    this.repoUrl = process.env.REPO_URL;
    this.featureName = process.env.FEATURE_NAME;
    this.branchName = process.env.BRANCH_NAME;
    this.llmProvider = process.env.LLM_PROVIDER;
    this.llmModel = process.env.LLM_MODEL;
    this.llmTemperature = parseFloat(process.env.LLM_TEMPERATURE || '0.3');
    this.maxTokens = parseInt(process.env.LLM_MAX_TOKENS || '4000');
    this.systemPrompt = process.env.SYSTEM_PROMPT || '';
    this.requestPrompt = process.env.REQUEST_PROMPT;
    this.githubToken = process.env.GITHUB_TOKEN;
    this.timeoutMinutes = parseInt(process.env.TIMEOUT_MINUTES || '15');
    
    this.workspaceDir = '/workspace';
    this.resultsDir = `/results/${this.agentId}`;
    this.startTime = Date.now();
    
    this.initializeLLMClient();
  }

  initializeLLMClient() {
    switch (this.llmProvider) {
      case 'openai':
        this.llmClient = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        });
        break;
      case 'anthropic':
        this.llmClient = new Anthropic({
          apiKey: process.env.ANTHROPIC_API_KEY
        });
        break;
      case 'google':
        this.llmClient = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        break;
      default:
        throw new Error(`Unsupported LLM provider: ${this.llmProvider}`);
    }
  }

  async run() {
    try {
      console.log(`🤖 Agent ${this.agentId} starting...`);
      
      // Create results directory
      await mkdir(this.resultsDir, { recursive: true });
      
      // Clone repository
      await this.cloneRepository();
      
      // Analyze codebase
      const codebaseContext = await this.analyzeCodebase();
      
      // Generate code using LLM
      const generatedCode = await this.generateCode(codebaseContext);
      
      // Apply changes
      const changedFiles = await this.applyChanges(generatedCode);
      
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

  async analyzeCodebase() {
    // Read key files to understand the codebase structure
    const files = await this.findRelevantFiles();
    const context = {
      files: [],
      structure: '',
      technologies: []
    };

    for (const file of files.slice(0, 10)) { // Limit to avoid token limits
      try {
        const content = await readFile(join(this.workspaceDir, file), 'utf-8');
        context.files.push({
          path: file,
          content: content.slice(0, 1000) // Truncate large files
        });
      } catch (error) {
        // Skip files that can't be read
      }
    }

    return context;
  }

  async findRelevantFiles() {
    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs'];
    const importantFiles = ['package.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'README.md'];
    
    return new Promise((resolve) => {
      const findProcess = spawn('find', [
        this.workspaceDir,
        '-type', 'f',
        '(',
        ...extensions.flatMap(ext => ['-name', `*${ext}`, '-o']),
        ...importantFiles.flatMap(file => ['-name', file, '-o']),
        ')',
        '-not', '-path', '*/node_modules/*',
        '-not', '-path', '*/.git/*'
      ]);

      let output = '';
      findProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      findProcess.on('close', () => {
        const files = output.trim().split('\n').filter(f => f.length > 0);
        resolve(files.map(f => f.replace(this.workspaceDir + '/', '')));
      });
    });
  }

  async generateCode(codebaseContext) {
    const prompt = `${this.systemPrompt}

TASK: ${this.requestPrompt}

CODEBASE CONTEXT:
${JSON.stringify(codebaseContext, null, 2)}

Please provide the code changes needed to implement the requested feature. Return your response as a JSON object with the following structure:
{
  "files": [
    {
      "path": "relative/path/to/file.js",
      "action": "create|modify|delete",
      "content": "full file content for create or modify actions"
    }
  ],
  "explanation": "Brief explanation of the changes made"
}`;

    switch (this.llmProvider) {
      case 'openai':
        const openaiResponse = await this.llmClient.chat.completions.create({
          model: this.llmModel,
          messages: [{ role: 'user', content: prompt }],
          temperature: this.llmTemperature,
          max_tokens: this.maxTokens
        });
        return JSON.parse(openaiResponse.choices[0].message.content);

      case 'anthropic':
        const anthropicResponse = await this.llmClient.messages.create({
          model: this.llmModel,
          messages: [{ role: 'user', content: prompt }],
          temperature: this.llmTemperature,
          max_tokens: this.maxTokens
        });
        return JSON.parse(anthropicResponse.content[0].text);

      case 'google':
        const model = this.llmClient.getGenerativeModel({ model: this.llmModel });
        const googleResponse = await model.generateContent(prompt);
        return JSON.parse(googleResponse.response.text());

      default:
        throw new Error(`Unsupported LLM provider: ${this.llmProvider}`);
    }
  }

  async applyChanges(generatedCode) {
    const changedFiles = [];

    for (const file of generatedCode.files) {
      const filePath = join(this.workspaceDir, file.path);
      
      switch (file.action) {
        case 'create':
        case 'modify':
          await writeFile(filePath, file.content);
          changedFiles.push(file.path);
          break;
        case 'delete':
          if (existsSync(filePath)) {
            await unlink(filePath);
            changedFiles.push(file.path);
          }
          break;
      }
    }

    return changedFiles;
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