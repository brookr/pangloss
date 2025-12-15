#!/usr/bin/env node

import { config as loadDotenv } from 'dotenv';
import { Command } from 'commander';
import chalk from 'chalk';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { Pangloss } from './pangloss.js';
import { loadConfig } from './config.js';
import { Planner } from './planner.js';
import { PanglossPlan } from './types.js';

// Load environment variables from .env file
loadDotenv();

// Validate required environment variables
function validateEnvironment() {
  const required = ['GITHUB_TOKEN'];
  const optional = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  
  const missing = required.filter(key => !process.env[key]);
  const availableProviders = optional.filter(key => process.env[key]);
  
  if (missing.length > 0) {
    console.warn(chalk.yellow(`⚠️  Missing required environment variables: ${missing.join(', ')}`));
    console.warn(chalk.yellow('💡 Create a .env file or set these variables manually'));
  }
  
  if (availableProviders.length === 0) {
    console.warn(chalk.yellow('⚠️  No LLM provider API keys found'));
    console.warn(chalk.yellow('💡 Set at least one: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY'));
  } else {
    console.log(chalk.green(`✅ Found API keys for: ${availableProviders.map(k => k.replace('_API_KEY', '')).join(', ')}`));
  }
}

const program = new Command();

program
  .name('pangloss')
  .description('Parallel LLM code generation - finding the best of all possible solutions')
  .version('1.0.0');

program
  .command('generate')
  .description('Generate code using multiple LLM agents in parallel')
  .option('-r, --repo <url>', 'GitHub repository URL')
  .option('-f, --feature <name>', 'Feature name (optional, used if skipping planning)')
  .option('-p, --prompt <text>', 'Code generation prompt (optional)')
  .option('--plan-file <path>', 'Path to existing plan JSON')
  .option('-a, --agents <list>', 'Comma-separated list of LLM agents', process.env.PANGLOSS_DEFAULT_AGENTS || 'codex-o3,claude-sonnet')
  .option('-c, --config <path>', 'Path to config file', process.env.PANGLOSS_CONFIG_PATH || './pangloss.config.json')
  .option('--timeout <minutes>', 'Timeout per agent in minutes', process.env.PANGLOSS_TIMEOUT_MINUTES || '15')
  .option('--merge-strategy <strategy>', 'Merge strategy (best_overall|best_per_file|composite)', process.env.PANGLOSS_MERGE_STRATEGY || 'best_overall')
  .option('--keep-branches', 'Keep non-winning branches for inspection')
  .action(async (options) => {
    try {
      console.log(chalk.blue('🤖 Pangloss - Finding the best of all possible solutions...\n'));
      
      // Validate environment variables
      validateEnvironment();
      console.log(); // Empty line for spacing
      
      const config = await loadConfig(options.config);
      const pangloss = new Pangloss(config);
      const planner = new Planner(config);
      
      let plan: PanglossPlan;
      let repoUrl = options.repo;
      let baseBranch = 'HEAD'; // Default if not detected/provided

      // Load or create plan
      if (options.planFile) {
        const planContent = await readFile(options.planFile, 'utf-8');
        plan = JSON.parse(planContent);
        console.log(chalk.blue(`Loaded plan from ${options.planFile}`));
        
        if (!repoUrl) {
            throw new Error('Repo URL is required when using a plan file (or must be detected via git)');
        }
      } else {
        // Interactive planning
        const planningResult = await planner.createPlan(process.cwd());
        plan = planningResult.plan;
        repoUrl = planningResult.repoUrl;
        baseBranch = planningResult.baseBranch;
      }
      
      const agents = options.agents.split(',').map((a: string) => a.trim());
      
      // Execute Run
      const result = await pangloss.execute({
        repo_url: repoUrl,
        base_branch: baseBranch,
        plan,
        agents,
        timeout_minutes: parseInt(options.timeout),
        keep_branches: options.keepBranches
      });
      
      // Save run metadata
      try {
          const runDir = join('.pangloss', 'runs', result.run_id);
          await mkdir(runDir, { recursive: true });
          
          await writeFile(join(runDir, 'plan.json'), JSON.stringify(plan, null, 2));
          await writeFile(join(runDir, 'plan.md'), generateMarkdownPlan(plan));
          await writeFile(join(runDir, 'run.json'), JSON.stringify({
              id: result.run_id,
              timestamp: new Date().toISOString(),
              repo_url: repoUrl,
              base_branch: baseBranch,
              agents,
              config
          }, null, 2));
          
          console.log(chalk.gray(`\nRun artifacts saved to .pangloss/runs/${result.run_id}/`));
      } catch (e) {
          console.warn('Failed to save run artifacts', e);
      }

      if (result.success) {
        console.log(chalk.green(`\n✅ Run ${result.run_id} completed successfully!`));
        // ...
      } else {
        console.error(chalk.red(`❌ Generation failed: ${result.error}`));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red(`💥 Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('config')
  .description('Generate default configuration file')
  .option('-o, --output <path>', 'Output path for config file', process.env.PANGLOSS_CONFIG_PATH || './pangloss.config.json')
  .action(async (options) => {
    const { generateDefaultConfig } = await import('./config.js');
    await generateDefaultConfig(options.output);
    console.log(chalk.green(`✅ Default config generated at ${options.output}`));
  });

program
  .command('setup')
  .description('Generate .env file template with placeholder values')
  .option('-o, --output <path>', 'Output path for .env file', './.env')
  .action(async (options) => {
    const { copyFile } = await import('fs/promises');
    const { existsSync } = await import('fs');
    
    if (existsSync(options.output)) {
      console.log(chalk.yellow(`⚠️  ${options.output} already exists. Use --output to specify a different path.`));
      return;
    }
    
    try {
      await copyFile('.env.example', options.output);
      console.log(chalk.green(`✅ Environment template created at ${options.output}`));
      console.log(chalk.cyan('💡 Edit the file and add your API keys to get started'));
    } catch (error) {
      console.error(chalk.red(`❌ Failed to create .env file: ${error instanceof Error ? error.message : 'Unknown error'}`));
    }
  });

function generateMarkdownPlan(plan: PanglossPlan): string {
  return `# Implementation Plan

## Summary
${plan.summary}

## Scope
${plan.scope.map((s: string) => `- ${s}`).join('\n')}

## Steps
${plan.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}

## Acceptance Criteria
${plan.acceptance_criteria.map((c: string) => `- [ ] ${c}`).join('\n')}

## Original Request
> ${plan.original_request}

## Clarifications
${plan.clarifications.map((qa: {question: string, answer: string}) => `**Q:** ${qa.question}\n**A:** ${qa.answer}`).join('\n\n')}
`;
}

program.parse();