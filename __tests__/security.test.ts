import { securityVerdict, coerceFindings } from '../src/security-util.js';

describe('coerceFindings', () => {
  it('normalizes severity/category and drops empty findings', () => {
    const out = coerceFindings([
      { severity: 'CRITICAL', category: 'SQL Injection', location: 'a.ts:1', detail: 'x', recommendation: 'y' },
      { severity: 'weird', detail: 'unknown-severity → low' },
      { location: '', detail: '' } // empty → dropped
    ] as never);
    expect(out).toHaveLength(2);
    expect(out[0].severity).toBe('critical');
    expect(out[0].category).toBe('sql injection');
    expect(out[1].severity).toBe('low');
  });
});

describe('securityVerdict', () => {
  it('fails on a high/critical finding', () => {
    expect(securityVerdict([{ severity: 'high', category: 'authz', location: 'x', detail: 'd', recommendation: 'r' }])).toEqual({
      highestSeverity: 'high',
      passed: false
    });
    expect(securityVerdict([{ severity: 'critical', category: 'injection', location: 'x', detail: 'd', recommendation: 'r' }]).passed).toBe(false);
  });

  it('passes when findings are only medium/low or empty', () => {
    expect(securityVerdict([]).passed).toBe(true);
    expect(securityVerdict([]).highestSeverity).toBe('none');
    const v = securityVerdict([
      { severity: 'low', category: 'dos', location: 'x', detail: 'd', recommendation: 'r' },
      { severity: 'medium', category: 'crypto', location: 'y', detail: 'd', recommendation: 'r' }
    ]);
    expect(v).toEqual({ highestSeverity: 'medium', passed: true });
  });
});
