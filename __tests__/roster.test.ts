import { getDefaultConfig, parseDynamicPreset, resolveRoster } from '../src/config.js';

describe('parseDynamicPreset', () => {
  it('synthesizes an OpenRouter preset from openrouter:<slug>', () => {
    expect(parseDynamicPreset('openrouter:qwen/qwen3-coder')).toEqual({
      id: 'or-qwen-qwen3-coder',
      tool: 'codex',
      model: 'qwen/qwen3-coder',
      openrouter: true,
      label: 'qwen/qwen3-coder (OpenRouter)'
    });
  });

  it('accepts the short or: prefix', () => {
    const p = parseDynamicPreset('or:z-ai/glm-4.6');
    expect(p).toMatchObject({ tool: 'codex', model: 'z-ai/glm-4.6', openrouter: true });
  });

  it('returns null for normal preset ids', () => {
    expect(parseDynamicPreset('claude-sonnet')).toBeNull();
  });
});

describe('resolveRoster', () => {
  const config = getDefaultConfig();

  it('resolves a named roster', () => {
    const presets = resolveRoster(config, 'openrouter');
    expect(presets.map((p) => p.id)).toEqual(['or-qwen-coder', 'or-deepseek', 'or-glm']);
    expect(presets.every((p) => p.openrouter)).toBe(true);
  });

  it('mixes ad-hoc OpenRouter models with named presets', () => {
    const presets = resolveRoster(config, 'openrouter:moonshotai/kimi-k2,claude-sonnet');
    expect(presets).toHaveLength(2);
    expect(presets[0]).toMatchObject({ model: 'moonshotai/kimi-k2', openrouter: true, tool: 'codex' });
    expect(presets[1].id).toBe('claude-sonnet');
  });

  it('throws on an unknown agent with a helpful hint', () => {
    expect(() => resolveRoster(config, 'totally-unknown')).toThrow(/openrouter:<slug>/);
  });

  it('requires at least two agents', () => {
    expect(() => resolveRoster(config, 'claude-sonnet')).toThrow(/at least 2/);
  });
});
