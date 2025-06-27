#!/usr/bin/env node

import { config as loadDotenv } from 'dotenv';
import { Command } from 'commander';
import chalk from 'chalk';
import { Pangloss } from './pangloss.js';
import { loadConfig } from './config.js';

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
  .requiredOption('-r, --repo <url>', 'GitHub repository URL')
  .requiredOption('-f, --feature <name>', 'Feature name to implement')
  .requiredOption('-p, --prompt <text>', 'Code generation prompt')
  .option('-a, --agents <list>', 'Comma-separated list of LLM agents', process.env.PANGLOSS_DEFAULT_AGENTS || 'codex-o3,claude-sonnet,gemini-pro')
  .option('-c, --config <path>', 'Path to config file', process.env.PANGLOSS_CONFIG_PATH || './pangloss.config.json')
  .option('--timeout <minutes>', 'Timeout per agent in minutes', process.env.PANGLOSS_TIMEOUT_MINUTES || '15')
  .option('--merge-strategy <strategy>', 'Merge strategy (best_overall|best_per_file|composite)', process.env.PANGLOSS_MERGE_STRATEGY || 'best_overall')
  .action(async (options) => {
    try {
      console.log(chalk.blue('🤖 Pangloss - Finding the best of all possible solutions...\n'));
      
      // Validate environment variables
      validateEnvironment();
      console.log(); // Empty line for spacing
      
      const config = await loadConfig(options.config);
      const pangloss = new Pangloss(config);
      
      const agents = options.agents.split(',').map((a: string) => a.trim());
      
      const result = await pangloss.generate({
        repo_url: options.repo,
        feature_name: options.feature,
        request_prompt: options.prompt,
        agents,
        timeout_minutes: parseInt(options.timeout),
        merge_strategy: options.mergeStrategy
      });
      
      if (result.success) {
        console.log(chalk.green(`✅ Generation completed! Final branch: ${result.final_branch}`));
        console.log(chalk.cyan(`📊 Results from ${result.agent_results.length} agents:`));
        
        result.agent_results.forEach(agent => {
          const status = agent.success ? chalk.green('✅') : chalk.red('❌');
          console.log(`  ${status} ${agent.agent_id}: ${agent.metrics.files_changed} files changed`);
        });
        
        if (result.pr_url) {
          console.log(chalk.blue(`🔗 Pull Request: ${result.pr_url}`));
        }
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

program.parse();