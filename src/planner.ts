import prompts from 'prompts';
import { spawn } from 'child_process';
import chalk from 'chalk';
import simpleGit from 'simple-git';
import { PanglossConfig, PanglossPlan, QA } from './types.js';

export class Planner {
  private config: PanglossConfig;
  private git = simpleGit();

  constructor(config: PanglossConfig) {
    this.config = config;
  }

  async createPlan(repoPath: string = process.cwd()): Promise<{ plan: PanglossPlan; repoUrl: string; baseBranch: string }> {
    // 1. Detect repo
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      throw new Error('Current directory is not a git repository');
    }

    const remotes = await this.git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    let repoUrl = origin?.refs.fetch || '';

    if (!repoUrl) {
      const response = await prompts({
        type: 'text',
        name: 'url',
        message: 'Could not detect origin remote. Please enter repository URL:',
        validate: (value: string) => value.length > 0 ? true : 'URL is required'
      });
      repoUrl = response.url;
    }

    const status = await this.git.status();
    const baseBranch = status.current || 'HEAD';

    console.log(chalk.blue(`\n📝 Planning for ${chalk.bold(repoUrl)} on branch ${chalk.bold(baseBranch)}`));

    // 2. Prompt for change
    const changeRequest = await prompts({
      type: 'text',
      name: 'request',
      message: 'What change do you want to make?',
      validate: (value: string) => value.length > 0 ? true : 'Request is required'
    });

    if (!changeRequest.request) {
        throw new Error('Operation cancelled');
    }

    const originalRequest = changeRequest.request;

    // 3. Clarifying questions
    console.log(chalk.yellow('\n🤔 Analyzing request and generating clarifying questions...'));
    const questions = await this.generateClarifyingQuestions(originalRequest, repoPath);

    const clarifications: QA[] = [];
    if (questions.length > 0) {
      console.log(chalk.cyan('\nPlease answer the following clarifying questions:'));
      
      for (const question of questions) {
        const answer = await prompts({
          type: 'text',
          name: 'value',
          message: question
        });
        clarifications.push({ question, answer: answer.value });
      }
    }

    // 4. Draft Plan & Iterate
    let plan = await this.draftPlan(originalRequest, clarifications, repoPath);

    let approved = false;
    while (!approved) {
      this.displayPlan(plan);

      const action = await prompts({
        type: 'select',
        name: 'value',
        message: 'Do you want to approve this plan?',
        choices: [
          { title: 'Approve Plan', value: 'approve' },
          { title: 'Request Changes', value: 'revise' },
          { title: 'Abort', value: 'abort' }
        ]
      });

      if (action.value === 'approve') {
        approved = true;
      } else if (action.value === 'abort') {
        throw new Error('Planning aborted by user');
      } else {
        const revision = await prompts({
          type: 'text',
          name: 'feedback',
          message: 'What changes would you like to make to the plan?'
        });
        
        console.log(chalk.yellow('\n🔄 Revising plan...'));
        plan = await this.revisePlan(plan, revision.feedback);
      }
    }

    return { plan, repoUrl, baseBranch };
  }

  private async generateClarifyingQuestions(request: string, repoPath: string): Promise<string[]> {
    const prompt = `You are a senior software architect. A user wants to make the following change to the codebase at ${repoPath}:
    
"${request}"

Based on this request, generate 3-5 targeted clarifying questions to ensure the implementation details are clear. 
Consider architectural implications, edge cases, and testing requirements.
Return ONLY the questions as a JSON array of strings. Do not include any other text.`;

    const output = await this.runLLM(prompt);
    try {
      return JSON.parse(output);
    } catch (e) {
      console.warn('Failed to parse questions JSON, falling back to raw split');
      return output.split('\n').filter(q => q.trim().length > 0).map(q => q.replace(/^\d+\.\s*/, '').trim());
    }
  }

  private async draftPlan(request: string, clarifications: QA[], repoPath: string): Promise<PanglossPlan> {
    const qaContext = clarifications.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n');
    
    const prompt = `You are a senior software architect. Create a detailed implementation plan for the following request:

Original Request: "${request}"

Clarifications:
${qaContext}

The plan should be for the codebase at ${repoPath}.
Return a valid JSON object matching this TypeScript interface:

interface PanglossPlan {
  summary: string;
  scope: string[]; // List of files or components to be modified
  steps: string[]; // Ordered implementation steps
  acceptance_criteria: string[]; // Testable criteria including E2E scenarios
  original_request: string; // The original request text
  clarifications: { question: string; answer: string }[];
}

Ensure the output is pure JSON.`;

    const output = await this.runLLM(prompt);
    try {
        // Find JSON block if wrapped in markdown
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? jsonMatch[0] : output;
        return JSON.parse(jsonStr);
    } catch (e) {
        throw new Error(`Failed to parse plan JSON: ${output.substring(0, 100)}...`);
    }
  }

  private async revisePlan(currentPlan: PanglossPlan, feedback: string): Promise<PanglossPlan> {
    const prompt = `Update the following implementation plan based on user feedback.

Current Plan:
${JSON.stringify(currentPlan, null, 2)}

User Feedback:
"${feedback}"

Return the updated plan as a valid JSON object matching the same schema.`;

    const output = await this.runLLM(prompt);
    try {
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? jsonMatch[0] : output;
        return JSON.parse(jsonStr);
    } catch (e) {
        throw new Error(`Failed to parse revised plan JSON`);
    }
  }

  private displayPlan(plan: PanglossPlan) {
    console.log(chalk.bold('\n📋 Implementation Plan'));
    console.log(chalk.gray('----------------------------------------'));
    
    console.log(chalk.bold('\nSummary:'));
    console.log(plan.summary);

    console.log(chalk.bold('\nScope:'));
    plan.scope.forEach(s => console.log(`- ${s}`));

    console.log(chalk.bold('\nSteps:'));
    plan.steps.forEach((s, i) => console.log(`${i + 1}. ${s}`));

    console.log(chalk.bold('\nAcceptance Criteria:'));
    plan.acceptance_criteria.forEach(c => console.log(`✅ ${c}`));
    
    console.log(chalk.gray('----------------------------------------'));
  }

  private async runLLM(prompt: string): Promise<string> {
    // Use the configured planner agent (defaulting to claude-sonnet logic for now)
    // In a real implementation, we'd use the configured LLM preset to choose the CLI/API
    // For this milestone, I'll assume 'claude' CLI is available and use it in non-interactive mode.
    
    const plannerAgentId = this.config.planner_agent || 'claude-sonnet';
    const preset = this.config.llm_presets[plannerAgentId];
    
    if (!preset) {
        throw new Error(`Planner agent '${plannerAgentId}' not found in config`);
    }

    // This is a simplification. In reality, we might need to support OpenAI/Gemini CLIs here too.
    // Assuming 'claude' CLI for now as per the plan "Milestone 1".
    
    return new Promise((resolve, reject) => {
        // Construct command based on provider
        // For v1, we'll try to use the 'claude' CLI command directly if provider is anthropic
        
        let command = 'claude';
        let args = ['-p', prompt];
        
        if (preset.provider === 'openai') {
            command = 'codex';
            args = ['--prompt', prompt, '--approval-mode', 'full-auto', '--quiet'];
        }

        // Add model arg if specified
        if (preset.cli_model && preset.provider === 'anthropic') {
           // Claude CLI uses -m or --model? usually just config. 
           // Let's assume standard piping for now.
        }

        // For this tool, we will just shell out.
        // NOTE: The 'claude' CLI might print extra text. We might need to handle that.
        // Using 'echo prompt | claude' pattern might be more robust if supported.
        
        const proc = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());

        proc.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(`LLM process exited with code ${code}: ${stderr}`));
            }
        });
        
        // Timeout
        setTimeout(() => {
            proc.kill();
            reject(new Error('LLM request timed out'));
        }, 60000); // 1 minute timeout for planning steps
    });
  }
}
