import { readFile, writeFile } from 'fs/promises';
import { PanglossConfig } from './types.js';

export async function loadConfig(configPath: string): Promise<PanglossConfig> {
  try {
    const configContent = await readFile(configPath, 'utf-8');
    return JSON.parse(configContent);
  } catch (error) {
    console.warn(`Warning: Could not load config from ${configPath}, using defaults`);
    return getDefaultConfig();
  }
}

export function getDefaultConfig(): PanglossConfig {
  return {
    llm_presets: {
      'codex-o3': {
        provider: 'openai',
        model: 'codex-cli',
        cli_model: 'o3',
        temperature: 0.2,
        max_tokens: 4000,
        system_prompt: 'Use OpenAI Codex CLI with o3 model for advanced reasoning and precise code generation.'
      },
      'codex-gpt4': {
        provider: 'openai',
        model: 'codex-cli',
        cli_model: 'gpt-4.1',
        temperature: 0.3,
        max_tokens: 4000,
        system_prompt: 'Use OpenAI Codex CLI with GPT-4.1 for well-tested code that follows best practices.'
      },
      'claude-sonnet': {
        provider: 'anthropic',
        model: 'claude-code-cli',
        cli_model: 'sonnet',
        temperature: 0.3,
        max_tokens: 4000,
        system_prompt: 'Use Claude Code CLI with Sonnet for thoughtful code architecture and maintainable solutions.'
      },
      'claude-opus': {
        provider: 'anthropic',
        model: 'claude-code-cli',
        cli_model: 'opus',
        temperature: 0.2,
        max_tokens: 4000,
        system_prompt: 'Use Claude Code CLI with Opus for complex reasoning and comprehensive code solutions.'
      },
      'claude-haiku': {
        provider: 'anthropic',
        model: 'claude-code-cli',
        cli_model: 'haiku',
        temperature: 0.1,
        max_tokens: 4000,
        system_prompt: 'Use Claude Code CLI with Haiku for fast, efficient code generation.'
      },
      'gemini-pro': {
        provider: 'google',
        model: 'gemini-cli',
        cli_model: 'gemini-2.5-pro',
        temperature: 0.3,
        max_tokens: 4000,
        system_prompt: 'Use Gemini CLI with 2.5 Pro for versatile code generation with large context.'
      },
      'gemini-flash': {
        provider: 'google',
        model: 'gemini-cli',
        cli_model: 'gemini-2.0-flash',
        temperature: 0.4,
        max_tokens: 4000,
        system_prompt: 'Use Gemini CLI with 2.0 Flash for fast code generation with built-in tool use.'
      }
    },
    default_agents: ['codex-o3', 'claude-sonnet', 'gemini-pro'],
    timeout_minutes: 15,
    max_parallel_agents: 5
  };
}

export async function generateDefaultConfig(outputPath: string): Promise<void> {
  const config = getDefaultConfig();
  await writeFile(outputPath, JSON.stringify(config, null, 2));
}