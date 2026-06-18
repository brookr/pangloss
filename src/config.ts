import { readFile, writeFile } from 'fs/promises';
import { AgentPreset, PanglossConfig } from './types.js';

/**
 * The agent catalog. Diversity is the product: a spread across vendors
 * (Anthropic / OpenAI / Google / Cursor) and tiers (local open-weight ->
 * sonnet-level -> frontier). `local: true` agents run entirely on-machine.
 *
 * Concurrency note: two `oss` agents pointed at the *same* large ollama model
 * will serialize through one model server. Keep at most one heavy local model
 * (gpt-oss:120b) per roster, or pair it with a smaller local model.
 */
const AGENT_PRESETS: Record<string, AgentPreset> = {
  // ---- Local open-weight (no cloud calls) ----
  gptoss: {
    id: 'gptoss',
    tool: 'codex',
    model: 'gpt-oss:120b',
    label: 'gpt-oss:120b (local, codex --oss)',
    oss: true,
    localProvider: 'ollama',
    local: true,
    persona: 'Pragmatic, test-first engineer. Favor the smallest correct change.'
  },
  'qwen-coder': {
    id: 'qwen-coder',
    tool: 'codex',
    model: 'qwen2.5-coder:7b',
    label: 'qwen2.5-coder:7b (local, codex --oss)',
    oss: true,
    localProvider: 'ollama',
    local: true,
    persona: 'Detail-oriented coder. Prioritize edge cases and input validation.'
  },

  // ---- Sonnet-level (cloud) ----
  'claude-sonnet': {
    id: 'claude-sonnet',
    tool: 'claude',
    model: 'sonnet',
    label: 'Claude Sonnet',
    persona: 'Thoughtful architect. Optimize for clarity and long-term maintainability.'
  },
  'gemini-flash': {
    id: 'gemini-flash',
    tool: 'gemini',
    model: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    persona: 'Fast, resourceful generalist. Cover the acceptance criteria efficiently.'
  },

  // ---- Frontier (cloud) ----
  'claude-opus': {
    id: 'claude-opus',
    tool: 'claude',
    model: 'opus',
    label: 'Claude Opus'
  },
  'codex-gpt5': {
    id: 'codex-gpt5',
    tool: 'codex',
    model: 'gpt-5',
    label: 'OpenAI GPT-5 (codex)'
  },
  'gemini-pro': {
    id: 'gemini-pro',
    tool: 'gemini',
    model: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro'
  },
  'cursor-gpt5': {
    id: 'cursor-gpt5',
    tool: 'cursor',
    model: 'gpt-5',
    label: 'GPT-5 via Cursor'
  },
  'cursor-sonnet': {
    id: 'cursor-sonnet',
    tool: 'cursor',
    model: 'claude-4.5-sonnet',
    label: 'Sonnet 4.5 via Cursor'
  },

  // ---- Open-weight via Cursor (cloud-served, but an open-weight model) ----
  'cursor-kimi': {
    id: 'cursor-kimi',
    tool: 'cursor',
    model: 'kimi-k2.5',
    label: 'Kimi K2.5 (open-weight via Cursor)',
    persona: 'Resourceful open-weight engineer. Prove the plan with thorough tests.'
  },

  // ---- Via OpenRouter (codex custom provider; needs OPENROUTER_API_KEY) ----
  // Slugs follow OpenRouter's catalog — verify/update with `pangloss models`.
  // You can also use any model ad hoc as `openrouter:<slug>` without a preset.
  'or-qwen-coder': {
    id: 'or-qwen-coder',
    tool: 'codex',
    model: 'qwen/qwen3-coder',
    openrouter: true,
    label: 'Qwen3 Coder (OpenRouter)',
    persona: 'Detail-oriented coder. Prioritize edge cases and input validation.'
  },
  'or-deepseek': {
    id: 'or-deepseek',
    tool: 'codex',
    model: 'deepseek/deepseek-chat-v3.1',
    openrouter: true,
    label: 'DeepSeek V3.1 (OpenRouter)'
  },
  'or-glm': {
    id: 'or-glm',
    tool: 'codex',
    model: 'z-ai/glm-4.6',
    openrouter: true,
    label: 'GLM 4.6 (OpenRouter)'
  },
  'or-kimi': {
    id: 'or-kimi',
    tool: 'codex',
    model: 'moonshotai/kimi-k2-0905',
    openrouter: true,
    label: 'Kimi K2 (OpenRouter)'
  }
};

/**
 * Named rosters. The default tests the core thesis: can a local open-weight
 * model + two sonnet-level models, looping and cross-reviewing, match frontier?
 */
const ROSTERS: Record<string, string[]> = {
  // The thesis roster: local open-weight (gpt-oss) + open-weight via Cursor
  // (Kimi K2.5) + a sonnet-level referee. Two open-weight lanes, one frontier-ish
  // tie-breaker — and the two open-weight agents don't contend for one model server.
  'open-weight-heavy': ['gptoss', 'cursor-kimi', 'claude-sonnet'],
  // No frontier at all — pure open-weight (gpt-oss local + Kimi via Cursor + local qwen).
  // Requires `ollama pull qwen2.5-coder:7b`.
  'open-weight-pure': ['gptoss', 'cursor-kimi', 'qwen-coder'],
  // Three open-weight models via OpenRouter (needs OPENROUTER_API_KEY) — no local GPU.
  openrouter: ['or-qwen-coder', 'or-deepseek', 'or-glm'],
  // Intra-family diversity: the SAME Sonnet family across three different
  // harnesses (claude-code, cursor-agent, codex→OpenRouter) + version/thinking
  // spread. Mostly subscription credit; the OpenRouter lane is the only paid one.
  'sonnet-family': [
    'claude:sonnet',
    'cursor:claude-4.6-sonnet-medium-thinking',
    'cursor:claude-4.5-sonnet',
    'openrouter:anthropic/claude-sonnet-4.6'
  ],
  // All three frontier models, different vendors — strongest baseline.
  frontier: ['codex-gpt5', 'claude-opus', 'gemini-pro'],
  // Maximum vendor/tier spread.
  diverse: ['gptoss', 'cursor-kimi', 'gemini-pro'],
  // Two genuinely-local models + a cloud referee (requires `ollama pull qwen2.5-coder:7b`).
  'all-local': ['gptoss', 'qwen-coder', 'claude-sonnet']
};

export function getDefaultConfig(): PanglossConfig {
  return {
    agent_presets: AGENT_PRESETS,
    rosters: ROSTERS,
    default_roster: 'open-weight-heavy',
    // Rotate who holds the synthesizer pen each round so no single taste dominates.
    synth_rotation: ['claude-sonnet', 'gptoss', 'cursor-kimi'],
    // Dogfood manifest: validate Pangloss against itself.
    manifest: {
      setup: 'yarn install --frozen-lockfile || yarn install',
      build: 'yarn build',
      test: 'yarn test',
      portBase: 4300,
      portOffset: 10
    },
    max_parallel_agents: 3,
    total_timeout_minutes: 30,
    local_timeout_minutes: 60,
    max_code_iterations: 4,
    max_rounds: 3,
    max_retries: 5,
    conventions: true
  };
}

export async function loadConfig(configPath: string): Promise<PanglossConfig> {
  try {
    const configContent = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(configContent) as Partial<PanglossConfig>;
    // Shallow-merge over defaults so partial config files still work.
    const defaults = getDefaultConfig();
    return {
      ...defaults,
      ...parsed,
      agent_presets: { ...defaults.agent_presets, ...(parsed.agent_presets ?? {}) },
      rosters: { ...defaults.rosters, ...(parsed.rosters ?? {}) },
      manifest: { ...defaults.manifest, ...(parsed.manifest ?? {}) }
    };
  } catch {
    console.warn(`Warning: Could not load config from ${configPath}, using defaults`);
    return getDefaultConfig();
  }
}

export async function generateDefaultConfig(outputPath: string): Promise<void> {
  await writeFile(outputPath, JSON.stringify(getDefaultConfig(), null, 2));
}

/**
 * Resolve a roster name, or a comma-separated list of preset ids / ad-hoc
 * `openrouter:<slug>` entries, into concrete presets. Errors clearly on unknowns.
 */
export function resolveRoster(config: PanglossConfig, rosterOrAgents?: string): AgentPreset[] {
  const spec = (rosterOrAgents ?? config.default_roster).trim();
  const ids = config.rosters[spec] ?? spec.split(',').map((s) => s.trim()).filter(Boolean);

  const presets = ids.map((id) => resolvePreset(config, id));
  if (presets.length < 2) {
    throw new Error(`Pangloss needs at least 2 agents for diversity; got ${presets.length}.`);
  }
  return presets;
}

function resolvePreset(config: PanglossConfig, id: string): AgentPreset {
  const dynamic = parseDynamicPreset(id);
  if (dynamic) return dynamic;

  const preset = config.agent_presets[id];
  if (!preset) {
    throw new Error(
      `Unknown agent or roster "${id}". Known rosters: ${Object.keys(config.rosters).join(', ')}. ` +
        `Known agents: ${Object.keys(config.agent_presets).join(', ')}. ` +
        `For an ad-hoc OpenRouter model, use "openrouter:<slug>" (e.g. openrouter:qwen/qwen3-coder).`
    );
  }
  return preset;
}

/**
 * Synthesize a preset from an ad-hoc `<tool>:<model>` id so any model on any
 * tool can be dropped into a roster without editing config. Supported prefixes:
 *   openrouter:/or:  -> codex via OpenRouter      cursor:  -> cursor-agent
 *   claude:          -> claude CLI                gemini:  -> gemini CLI
 *   codex:           -> codex (cloud)             oss:/codex-oss: -> codex --oss (local)
 * e.g. `cursor:claude-4.5-sonnet`, `openrouter:anthropic/claude-sonnet-4.6`.
 */
export function parseDynamicPreset(id: string): AgentPreset | null {
  const match = id.match(/^([a-z0-9-]+):(.+)$/i);
  if (!match) return null;
  const prefix = match[1].toLowerCase();
  let model = match[2].trim();
  // An optional @suffix yields a DISTINCT preset id for the SAME model — used for
  // homogeneous fusion / self-consistency (e.g. claude:sonnet@a, claude:sonnet@b).
  let suffix = '';
  const at = model.indexOf('@');
  if (at >= 0) {
    suffix = model.slice(at + 1).trim();
    model = model.slice(0, at).trim();
  }
  const slug = (p: string) =>
    `${p}-` + `${model}${suffix ? `-${suffix}` : ''}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');

  switch (prefix) {
    case 'openrouter':
    case 'or':
      return { id: slug('or'), tool: 'codex', model, openrouter: true, label: `${model} (OpenRouter)` };
    case 'cursor':
      return { id: slug('cursor'), tool: 'cursor', model, label: `${model} (Cursor)` };
    case 'claude':
      return { id: slug('claude'), tool: 'claude', model, label: `${model} (Claude)` };
    case 'gemini':
      return { id: slug('gemini'), tool: 'gemini', model, label: `${model} (Gemini)` };
    case 'codex':
      return { id: slug('codex'), tool: 'codex', model, label: `${model} (Codex)` };
    case 'oss':
    case 'codex-oss':
      return {
        id: slug('oss'),
        tool: 'codex',
        model,
        oss: true,
        localProvider: 'ollama',
        local: true,
        label: `${model} (local oss)`
      };
    default:
      return null;
  }
}
