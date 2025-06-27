#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { Pangloss } from './pangloss.js';
import { loadConfig } from './config.js';

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
  .option('-a, --agents <list>', 'Comma-separated list of LLM agents', 'codex,claude-sonnet,gemini-pro')
  .option('-c, --config <path>', 'Path to config file', './pangloss.config.json')
  .option('--timeout <minutes>', 'Timeout per agent in minutes', '15')
  .option('--merge-strategy <strategy>', 'Merge strategy (best_overall|best_per_file|composite)', 'best_overall')
  .action(async (options) => {
    try {
      console.log(chalk.blue('🤖 Pangloss - Finding the best of all possible solutions...\n'));
      
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
  .option('-o, --output <path>', 'Output path for config file', './pangloss.config.json')
  .action(async (options) => {
    const { generateDefaultConfig } = await import('./config.js');
    await generateDefaultConfig(options.output);
    console.log(chalk.green(`✅ Default config generated at ${options.output}`));
  });

program.parse();