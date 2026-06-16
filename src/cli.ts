#!/usr/bin/env node

import { config as loadDotenv } from 'dotenv';
import { Command } from 'commander';
import chalk from 'chalk';
import { AgentAdapter } from './agents/adapter.js';
import { generateDefaultConfig, loadConfig, resolveRoster } from './config.js';
import { executeRun } from './orchestrator.js';
import { run as runProc } from './util/proc.js';

loadDotenv();

const program = new Command();

program
  .name('pangloss')
  .description('Parallel, multi-model code generation — the best of all possible worlds')
  .version('2.0.0');

program
  .command('run', { isDefault: true })
  .description('Plan → code → review → select across a diverse roster of models')
  .option('-r, --request <text>', 'The feature request (required in non-interactive mode)')
  .option('--roster <name|csv>', 'Roster name or comma-separated agent ids')
  .option('-c, --config <path>', 'Path to config file', process.env.PANGLOSS_CONFIG_PATH || './pangloss.config.json')
  .option('-y, --yes', 'Auto-approve the synthesized plan (no approval gate)')
  .option('--non-interactive', 'Never prompt; requires --request and implies --yes')
  .option('--keep-worktrees', 'Keep all worktrees for inspection (default: keep winner only)')
  .option('--rounds <n>', 'Max revise-loop rounds (stops earlier on convergence)')
  .option('--timeout <minutes>', 'Wall-clock cap per cloud agent invocation')
  .option('--local-timeout <minutes>', 'Wall-clock cap per local (oss) agent invocation (local models can be slow)')
  .option('--run-id <id>', 'Override the generated run id')
  .action(async (options) => {
    const nonInteractive: boolean = options.nonInteractive ?? false;
    const interactive = Boolean(process.stdout.isTTY) && !nonInteractive;

    if (nonInteractive && !options.request) {
      console.error(chalk.red('--non-interactive requires --request "…"'));
      process.exit(1);
    }

    const result = await executeRun({
      repoRoot: process.cwd(),
      configPath: options.config,
      roster: options.roster,
      request: options.request,
      interactive,
      autoApprove: options.yes || nonInteractive,
      keepWorktrees: Boolean(options.keepWorktrees),
      maxRounds: options.rounds ? parseInt(options.rounds, 10) : undefined,
      timeoutMinutes: options.timeout ? parseInt(options.timeout, 10) : undefined,
      localTimeoutMinutes: options.localTimeout ? parseInt(options.localTimeout, 10) : undefined,
      runId: options.runId
    });

    if (result.success) {
      console.log(chalk.green(`\n✅ Run ${result.runId} complete (${result.rounds} round(s)).`));
    } else {
      console.error(chalk.red(`\n❌ Run ${result.runId} failed: ${result.error ?? 'unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('agents')
  .description('List configured rosters and agent presets')
  .option('-c, --config <path>', 'Path to config file', process.env.PANGLOSS_CONFIG_PATH || './pangloss.config.json')
  .action(async (options) => {
    const config = await loadConfig(options.config);
    console.log(chalk.bold('\nRosters:'));
    for (const [name, ids] of Object.entries(config.rosters)) {
      const def = name === config.default_roster ? chalk.green(' (default)') : '';
      console.log(`  ${chalk.cyan(name)}${def}: ${ids.join(', ')}`);
    }
    console.log(chalk.bold('\nAgent presets:'));
    for (const p of Object.values(config.agent_presets)) {
      const tag = p.local
        ? chalk.yellow('[local]')
        : p.openrouter
          ? chalk.magenta('[openrouter]')
          : chalk.gray('[cloud]');
      console.log(`  ${chalk.cyan(p.id.padEnd(14))} ${tag.padEnd(22)} ${p.tool} · ${p.model}  ${chalk.gray(p.label ?? '')}`);
    }
    console.log(chalk.gray('\nTip: drop any OpenRouter model into a roster ad hoc, e.g.'));
    console.log(chalk.gray('  pangloss run --roster "openrouter:qwen/qwen3-coder,openrouter:z-ai/glm-4.6,claude-sonnet"'));
    console.log();
  });

program
  .command('models')
  .description('List OpenRouter model slugs you can use as openrouter:<slug>')
  .option('-f, --filter <text>', 'Case-insensitive substring filter')
  .action(async (options) => {
    const headers: Record<string, string> = {};
    if (process.env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/models', { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = (await resp.json()) as { data?: Array<{ id: string; name?: string }> };
      const filter = (options.filter ?? '').toLowerCase();
      const rows = (body.data ?? [])
        .filter((m) => !filter || m.id.toLowerCase().includes(filter) || (m.name ?? '').toLowerCase().includes(filter))
        .sort((a, b) => a.id.localeCompare(b.id));
      console.log(chalk.bold(`\n${rows.length} OpenRouter models${filter ? ` matching "${options.filter}"` : ''}:\n`));
      for (const m of rows) console.log(`  ${chalk.cyan(m.id.padEnd(40))} ${chalk.gray(m.name ?? '')}`);
      console.log(chalk.gray(`\nUse one with:  pangloss run --roster "openrouter:<slug>,claude-sonnet,gptoss"`));
    } catch (err) {
      console.error(chalk.red(`Failed to fetch OpenRouter models: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Check that roster CLIs are installed and preview their invocations')
  .option('-c, --config <path>', 'Path to config file', process.env.PANGLOSS_CONFIG_PATH || './pangloss.config.json')
  .option('--roster <name|csv>', 'Roster to check (default: configured default)')
  .action(async (options) => {
    const config = await loadConfig(options.config);
    const presets = resolveRoster(config, options.roster);

    console.log(chalk.bold('\nTool availability:'));
    const tools = [...new Set(presets.map((p) => toolBinary(p.tool)))];
    for (const bin of tools) {
      const ok = (await runProc('which', [bin], {})).ok;
      console.log(`  ${ok ? chalk.green('✓') : chalk.red('✗')} ${bin}`);
    }

    const needsOllama = presets.some((p) => p.oss);
    if (needsOllama) {
      const res = await runProc('curl', ['-sS', '-m', '3', 'http://localhost:11434/api/tags'], {});
      console.log(`  ${res.ok ? chalk.green('✓') : chalk.red('✗')} ollama server (:11434) for --oss agents`);
    }

    if (presets.some((p) => p.openrouter)) {
      const ok = Boolean(process.env.OPENROUTER_API_KEY);
      console.log(`  ${ok ? chalk.green('✓') : chalk.red('✗')} OPENROUTER_API_KEY ${ok ? 'set' : 'missing (add it to .env)'} for openrouter agents`);
    }

    console.log(chalk.bold('\nResolved code-phase invocations:'));
    for (const preset of presets) {
      const adapter = new AgentAdapter(preset);
      const preview = adapter.previewCommand({
        mode: 'code',
        prompt: '<plan>',
        cwd: '<worktree>',
        system: '<contract>',
        timeoutMs: 0
      });
      console.log(`  ${chalk.cyan(preset.id.padEnd(14))} ${preview}`);
    }
    console.log();
  });

program
  .command('config')
  .description('Generate the default configuration file')
  .option('-o, --output <path>', 'Output path', process.env.PANGLOSS_CONFIG_PATH || './pangloss.config.json')
  .action(async (options) => {
    await generateDefaultConfig(options.output);
    console.log(chalk.green(`✅ Default config written to ${options.output}`));
  });

program
  .command('setup')
  .description('Generate a .env template')
  .option('-o, --output <path>', 'Output path', './.env')
  .action(async (options) => {
    const { copyFile } = await import('fs/promises');
    const { existsSync } = await import('fs');
    if (existsSync(options.output)) {
      console.log(chalk.yellow(`⚠️  ${options.output} already exists.`));
      return;
    }
    await copyFile('.env.example', options.output);
    console.log(chalk.green(`✅ Wrote ${options.output} — edit it as needed (CLIs may already be authed).`));
  });

program.parseAsync();

function toolBinary(tool: string): string {
  return tool === 'cursor' ? 'cursor-agent' : tool;
}
