import { parseTestOutput } from '../src/validate.js';

describe('parseTestOutput', () => {
  it('parses a Jest summary line with failures', () => {
    const out = 'Tests:       2 failed, 1 skipped, 3 passed, 6 total';
    expect(parseTestOutput(out, false)).toEqual({ passed: 3, failed: 2, total: 6 });
  });

  it('parses a Jest all-passing summary', () => {
    expect(parseTestOutput('Tests:       4 passed, 4 total', true)).toEqual({ passed: 4, failed: 0, total: 4 });
  });

  it('parses Mocha-style output', () => {
    expect(parseTestOutput('  12 passing\n  3 failing\n', false)).toEqual({ passed: 12, failed: 3, total: 15 });
  });

  it('falls back to exit status when nothing is parseable', () => {
    expect(parseTestOutput('weird custom runner output', true)).toEqual({ passed: 1, failed: 0, total: 1 });
    expect(parseTestOutput('weird custom runner output', false)).toEqual({ passed: 0, failed: 1, total: 1 });
  });
});
