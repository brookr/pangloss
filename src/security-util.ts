import { PanglossPlan, SecurityAudit, SecurityFinding, Severity } from './types.js';

/**
 * Pure security-finding helpers — chalk-free so they're unit-testable in
 * isolation (the security phase itself pulls in adapters + chalk).
 */

export const SEVERITY_RANK: Record<Severity, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

export interface RawFinding {
  severity?: string;
  category?: string;
  location?: string;
  detail?: string;
  recommendation?: string;
}

export function coerceFindings(raw?: RawFinding[]): SecurityFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => f && (f.detail || f.location))
    .map((f) => ({
      severity: coerceSeverity(f.severity),
      category: String(f.category ?? 'other')
        .trim()
        .toLowerCase()
        .slice(0, 40),
      location: String(f.location ?? '').trim().slice(0, 200),
      detail: String(f.detail ?? '').slice(0, 600),
      recommendation: String(f.recommendation ?? '').slice(0, 600)
    }));
}

/**
 * Normalize a model-supplied severity to the canonical scale. This is a SECURITY
 * gate, so it must fail SAFE: anything unrecognized but non-empty escalates to
 * `high` rather than silently sinking below the fail threshold. Trims/strips
 * decoration ("High (CVSS 8.1)", "HIGH\n") and maps common synonyms. Absent
 * severity → `low` (such findings carry no detail and are usually dropped anyway).
 */
export function coerceSeverity(s?: string): Severity {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v) return 'low';
  const first = v.split(/[^a-z]/)[0]; // "high (cvss 8.1)" → "high"; "high\n" → "high"
  if (first === 'critical' || first === 'high' || first === 'medium' || first === 'low') return first;
  if (['severe', 'crit', 'blocker', 'fatal'].includes(first)) return 'critical';
  if (['important', 'serious', 'major'].includes(first)) return 'high';
  if (['moderate', 'warning', 'warn'].includes(first)) return 'medium';
  if (['info', 'informational', 'note', 'notice', 'minor', 'trivial', 'none'].includes(first)) return 'low';
  return 'high'; // unrecognized but present → escalate, never silently pass
}

export function highestSeverity(findings: SecurityFinding[]): Severity {
  return findings.reduce<Severity>((acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc), 'none');
}

/** Verdict: the worst severity and whether it passes the threshold (no high/critical). */
export function securityVerdict(findings: SecurityFinding[]): { highestSeverity: Severity; passed: boolean } {
  const sev = highestSeverity(findings);
  return { highestSeverity: sev, passed: SEVERITY_RANK[sev] < SEVERITY_RANK.high };
}

/** The findings that fail the threshold (high/critical) — the ones an auto-hardening round must fix. */
export function highFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high);
}

/**
 * Turn a failed security audit into a focused remediation plan, deterministically
 * (no extra model call): each high/critical finding becomes a must-fix step, the
 * affected files become the scope, and the acceptance criteria pin "remediate +
 * don't regress" on top of the original plan's criteria. The agents still fuse on
 * the fix — this just seeds the round.
 */
export function securityFixPlan(prevPlan: PanglossPlan, audit: SecurityAudit): PanglossPlan {
  const high = highFindings(audit.findings);
  const files = [...new Set(high.map((f) => f.location.split(':')[0].trim()).filter(Boolean))];
  return {
    summary:
      `Security hardening: remediate ${high.length} high/critical finding(s) in the current implementation ` +
      `WITHOUT changing intended behavior or weakening any tests.`,
    scope: files,
    steps: high.map(
      (f) =>
        `Remediate [${f.severity}/${f.category}] at ${f.location}: ${f.detail}` +
        (f.recommendation ? ` — ${f.recommendation}` : '')
    ),
    acceptance_criteria: [
      'Every listed high/critical security finding is fully remediated.',
      'No existing behavior regresses and all previously-passing tests still pass.',
      ...prevPlan.acceptance_criteria
    ],
    original_request: prevPlan.original_request,
    clarifications: prevPlan.clarifications,
    synthesized_by: 'security-audit',
    round: prevPlan.round
  };
}
