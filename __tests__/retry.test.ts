import { isTransientFailure, retryDelayMs } from '../src/agents/adapter.js';
import type { AdapterRunResult } from '../src/agents/adapter.js';

function res(p: Partial<AdapterRunResult>): AdapterRunResult {
  return { ok: false, stdout: '', stderr: '', code: 1, timedOut: false, durationMs: 0, ...p };
}

describe('isTransientFailure', () => {
  it('detects rate-limit / transient signals', () => {
    expect(isTransientFailure(res({ stderr: 'HTTP 429 Too Many Requests' }))).toBe(true);
    expect(isTransientFailure(res({ stdout: "We're currently experiencing high demand" }))).toBe(true);
    expect(isTransientFailure(res({ stderr: 'rate-limited; please slow down' }))).toBe(true);
    expect(isTransientFailure(res({ stderr: 'Reconnecting... 3/5' }))).toBe(true);
    expect(isTransientFailure(res({ stderr: 'upstream returned 503 Service Unavailable' }))).toBe(true);
    expect(isTransientFailure(res({ stderr: 'ECONNRESET' }))).toBe(true);
  });

  it('does NOT retry success, timeouts, or genuine errors', () => {
    expect(isTransientFailure(res({ ok: true, code: 0 }))).toBe(false);
    expect(isTransientFailure(res({ timedOut: true, stderr: '429' }))).toBe(false); // a wall-clock timeout, not a 429
    expect(isTransientFailure(res({ stderr: "SyntaxError: unexpected token" }))).toBe(false);
  });

  it('retries an exited-0-but-empty lane (the silent cursor/gemini drop)', () => {
    expect(isTransientFailure(res({ emptyOutput: true, code: 0 }))).toBe(true);
    expect(isTransientFailure(res({ emptyOutput: true, timedOut: true }))).toBe(false); // never retry a timeout
  });
});

describe('retryDelayMs', () => {
  it('honors an explicit retry-after hint', () => {
    expect(retryDelayMs(res({ stderr: 'Retry-After: 12' }), 1, 2000)).toBe(12 * 1000 + 500);
    expect(retryDelayMs(res({ stdout: 'please try again in 30 seconds' }), 1, 2000)).toBe(30 * 1000 + 500);
  });

  it('falls back to exponential backoff that grows with the attempt and is capped', () => {
    const d1 = retryDelayMs(res({ stderr: '429' }), 1, 2000);
    const d3 = retryDelayMs(res({ stderr: '429' }), 3, 2000);
    expect(d1).toBeGreaterThanOrEqual(2000);
    expect(d3).toBeGreaterThan(d1);
    expect(retryDelayMs(res({ stderr: '429' }), 20, 2000)).toBeLessThanOrEqual(90_000);
  });
});
