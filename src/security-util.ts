import { SecurityFinding, Severity } from './types.js';

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
  const sev = (s?: string): Severity => {
    const v = String(s ?? '').toLowerCase();
    return (['critical', 'high', 'medium', 'low'].includes(v) ? v : 'low') as Severity;
  };
  return raw
    .filter((f) => f && (f.detail || f.location))
    .map((f) => ({
      severity: sev(f.severity),
      category: String(f.category ?? 'other')
        .toLowerCase()
        .slice(0, 40),
      location: String(f.location ?? '').slice(0, 200),
      detail: String(f.detail ?? '').slice(0, 600),
      recommendation: String(f.recommendation ?? '').slice(0, 600)
    }));
}

export function highestSeverity(findings: SecurityFinding[]): Severity {
  return findings.reduce<Severity>((acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc), 'none');
}

/** Verdict: the worst severity and whether it passes the threshold (no high/critical). */
export function securityVerdict(findings: SecurityFinding[]): { highestSeverity: Severity; passed: boolean } {
  const sev = highestSeverity(findings);
  return { highestSeverity: sev, passed: SEVERITY_RANK[sev] < SEVERITY_RANK.high };
}
