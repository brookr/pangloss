import { extractJsonBlock } from '../src/util/extract.js';

describe('extractJsonBlock', () => {
  it('pulls an object out of surrounding prose', () => {
    expect(extractJsonBlock('Sure! Here is the result: {"a":1,"b":2} — done.')).toEqual({ a: 1, b: 2 });
  });

  it('handles markdown code fences', () => {
    const text = 'Plan:\n```json\n{"summary":"x","scope":[]}\n```\nthanks';
    expect(extractJsonBlock(text)).toEqual({ summary: 'x', scope: [] });
  });

  it('matches balanced braces even when strings contain braces', () => {
    const text = 'noise {"a":{"b":[1,2]},"c":"a } b"} trailing log line }';
    expect(extractJsonBlock(text)).toEqual({ a: { b: [1, 2] }, c: 'a } b' });
  });

  it('extracts top-level arrays', () => {
    expect(extractJsonBlock('Questions: ["one","two","three"]')).toEqual(['one', 'two', 'three']);
  });

  it('returns null when there is no JSON', () => {
    expect(extractJsonBlock('no json here at all')).toBeNull();
    expect(extractJsonBlock('')).toBeNull();
  });

  it('skips a malformed leading object and is resilient to trailing noise', () => {
    expect(extractJsonBlock('{"ok":true} [info] extra stuff')).toEqual({ ok: true });
  });
});
