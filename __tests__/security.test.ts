import { securityVerdict, coerceFindings, coerceSeverity, highFindings, securityFixPlan } from '../src/security-util.js';
import { PanglossPlan, SecurityAudit } from '../src/types.js';

describe('coerceFindings', () => {
  it('normalizes severity/category and drops empty findings', () => {
    const out = coerceFindings([
      { severity: 'CRITICAL', category: 'SQL Injection', location: 'a.ts:1', detail: 'x', recommendation: 'y' },
      { severity: 'weird', detail: 'unknown-severity → high (fail-safe escalation)' },
      { location: '', detail: '' } // empty → dropped
    ] as never);
    expect(out).toHaveLength(2);
    expect(out[0].severity).toBe('critical');
    expect(out[0].category).toBe('sql injection');
    expect(out[1].severity).toBe('high'); // fail SAFE: unrecognized severity escalates, never silently 'low'
  });
});

describe('coerceSeverity (fail-safe normalization)', () => {
  it('canonicalizes case and strips decoration/whitespace', () => {
    expect(coerceSeverity('CRITICAL')).toBe('critical');
    expect(coerceSeverity(' High ')).toBe('high'); // trailing/leading whitespace
    expect(coerceSeverity('HIGH\n')).toBe('high'); // trailing newline
    expect(coerceSeverity('High (CVSS 8.1)')).toBe('high'); // decorated
  });

  it('maps common synonyms', () => {
    expect(coerceSeverity('severe')).toBe('critical');
    expect(coerceSeverity('important')).toBe('high');
    expect(coerceSeverity('moderate')).toBe('medium');
    expect(coerceSeverity('informational')).toBe('low');
  });

  it('fails SAFE: unrecognized non-empty severity escalates to high, not low', () => {
    expect(coerceSeverity('spicy')).toBe('high');
    expect(coerceSeverity('???')).toBe('high');
  });

  it('treats absent/empty severity as low (such findings carry no signal)', () => {
    expect(coerceSeverity('')).toBe('low');
    expect(coerceSeverity(undefined)).toBe('low');
  });

  it('a whitespace-padded high finding still FAILS the gate (no silent downgrade)', () => {
    const findings = coerceFindings([{ severity: 'High ', category: 'authz', location: 'x', detail: 'd' }] as never);
    expect(findings[0].severity).toBe('high');
    expect(securityVerdict(findings).passed).toBe(false);
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

describe('securityFixPlan', () => {
  const basePlan: PanglossPlan = {
    summary: 'Original feature',
    scope: ['api/feature.ts'],
    steps: ['do the feature'],
    acceptance_criteria: ['feature works'],
    original_request: 'add feature',
    clarifications: [],
    synthesized_by: 'planner',
    round: 0
  };
  const audit: SecurityAudit = {
    findings: [
      { severity: 'critical', category: 'injection', location: 'api/user.ts:2', detail: 'SQLi', recommendation: 'parameterize' },
      { severity: 'high', category: 'authz', location: 'api/user.ts:1-5', detail: 'no authz', recommendation: 'add check' },
      { severity: 'low', category: 'dos', location: 'api/util.ts:9', detail: 'minor', recommendation: 'cap input' }
    ],
    highestSeverity: 'critical',
    passed: false,
    summary: 'bad',
    auditors: 2
  };

  it('keeps only high/critical findings as must-fix work', () => {
    expect(highFindings(audit.findings).map((f) => f.severity)).toEqual(['critical', 'high']);
  });

  it('turns the audit into a remediation plan scoped to the affected files', () => {
    const plan = securityFixPlan(basePlan, audit);
    // low-severity finding is excluded — only the two high/critical become steps.
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toContain('[critical/injection] at api/user.ts:2');
    expect(plan.steps[0]).toContain('parameterize');
    // file-level scope, de-duplicated (both findings live in api/user.ts).
    expect(plan.scope).toEqual(['api/user.ts']);
    // original criteria are preserved underneath the remediation criteria.
    expect(plan.acceptance_criteria).toContain('feature works');
    expect(plan.acceptance_criteria[0]).toMatch(/remediated/i);
    // carries identity through so the revise round keeps context.
    expect(plan.original_request).toBe('add feature');
    expect(plan.synthesized_by).toBe('security-audit');
  });

  it('dedupes multi-file scope across findings', () => {
    const multi: SecurityAudit = {
      findings: [
        { severity: 'critical', category: 'injection', location: 'api/user.ts:2', detail: 'SQLi', recommendation: 'x' },
        { severity: 'high', category: 'ssrf', location: 'api/fetch.ts:9', detail: 'ssrf', recommendation: 'y' },
        { severity: 'high', category: 'authz', location: 'api/user.ts:40', detail: 'authz', recommendation: 'z' }
      ],
      highestSeverity: 'critical',
      passed: false,
      summary: 'bad',
      auditors: 3
    };
    const plan = securityFixPlan(basePlan, multi);
    expect(plan.steps).toHaveLength(3);
    expect(plan.scope.sort()).toEqual(['api/fetch.ts', 'api/user.ts']); // de-duplicated, file-level
  });
});
