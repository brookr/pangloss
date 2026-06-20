import chalk from 'chalk';
import { composeSystem } from '../agents/contract.js';
import { RunContext } from '../context.js';
import { PanglossPlan, SecurityAudit, SecurityFinding, Severity, SelectionOutcome } from '../types.js';
import { extractJsonBlock } from '../util/extract.js';
import { mapPool } from '../util/pool.js';
import { securityAuditPrompt, securitySynthPrompt } from './prompts.js';
import { pickSynthesizer } from './plan.js';
import { RawFinding, SEVERITY_RANK as RANK, coerceFindings, highestSeverity, securityVerdict } from '../security-util.js';

const MAX_DIFF = 48000;

/**
 * Cap the diff for the prompt without silently hiding code. Slices on a line
 * boundary (never mid-hunk) and reports whether anything was dropped, so the
 * auditor can be told the change is partial instead of auditing a fragment it
 * believes is complete (a truncated tail must not be read as "clean").
 */
function capDiff(full: string): { diff: string; truncated: boolean } {
  if (full.length <= MAX_DIFF) return { diff: full, truncated: false };
  const cut = full.slice(0, MAX_DIFF);
  const lastNl = cut.lastIndexOf('\n');
  return { diff: lastNl > 0 ? cut.slice(0, lastNl) : cut, truncated: true };
}

/**
 * Phase 5 — the FINAL threshold. Every model independently security-audits the
 * winning change; a rotating synthesizer consolidates the findings into one
 * verdict. Passes when there are no high/critical findings. No-op when disabled
 * (config.security_audit === false) or the winner has no diff.
 */
export async function runSecurityAudit(
  ctx: RunContext,
  plan: PanglossPlan,
  selection: SelectionOutcome,
  baseRef?: string
): Promise<SecurityAudit | null> {
  if (ctx.config.security_audit === false) return null;

  const winner = { agentId: selection.winnerAgentId, branch: selection.winnerBranch, path: selection.winnerWorktree };
  // Always audit the COMPLETE change (feature + any hardening), so diff against the
  // run's origin base — not ctx.baseRef, which advances to a winner branch across
  // revise/hardening rounds (that would shrink the audit to just the latest delta).
  const fullDiff = await ctx.worktrees.fullDiff(winner, baseRef ?? ctx.baseRef);
  if (!fullDiff.trim()) return null;
  const { diff, truncated } = capDiff(fullDiff);

  ctx.logger.phase('Phase 5 — Security audit: every model audits the winner, then synthesize');
  if (truncated) {
    ctx.logger.warn(chalk.yellow(`⚠ Winner diff is ${fullDiff.length} chars — auditing the first ${diff.length} (auditors told it is partial).`));
  }

  // Each lane audits the winning diff independently.
  const audits = (
    await mapPool(ctx.adapters, ctx.config.max_parallel_agents, async (adapter) => {
      try {
        const res = await adapter.run({
          mode: 'review',
          prompt: securityAuditPrompt(plan, diff, ctx.conventions?.full, truncated),
          cwd: winner.path,
          system: composeSystem(adapter.preset, 'review'),
          timeoutMs: adapter.timeoutMs,
          onRetry: (m) => ctx.logger.agent(adapter.id, chalk.yellow(m))
        });
        const raw = extractJsonBlock<{ findings?: RawFinding[] }>(res.stdout);
        if (!raw) {
          ctx.logger.agent(adapter.id, chalk.yellow('security audit unparseable — skipped'));
          return null;
        }
        const findings = coerceFindings(raw.findings);
        const worst = highestSeverity(findings);
        ctx.logger.agent(
          adapter.id,
          findings.length ? colorBySeverity(worst)(`flagged ${findings.length} (${worst})`) : chalk.gray('no security findings')
        );
        return { auditor: adapter.id, findings };
      } catch (err) {
        ctx.logger.agent(adapter.id, chalk.yellow(`security audit errored — skipped (${err instanceof Error ? err.message : String(err)})`));
        return null;
      }
    })
  ).filter((a): a is { auditor: string; findings: SecurityFinding[] } => a !== null);

  // Fail CLOSED: if no auditor produced a usable result (every lane errored / was
  // unparseable — e.g. a shared rate-limit or auth outage), do NOT report PASS. A
  // systemic audit failure must be indistinguishable from "vulnerable", never from
  // "clean". `auditors: 0` is the tell; there are no findings to harden, so the
  // hardening loop will record it for manual review rather than spin a empty round.
  if (audits.length === 0) {
    ctx.logger.warn(chalk.red('\n🔒 Security audit INCONCLUSIVE — no auditor produced a usable result; failing closed (treated as NOT passed).'));
    return { findings: [], highestSeverity: 'none', passed: false, summary: 'Inconclusive: no auditor produced a parseable result.', auditors: 0 };
  }

  // Synthesize one verdict (dedupe, keep highest severity, drop false positives).
  let findings: SecurityFinding[];
  let summary = '';
  const synth = pickSynthesizer(ctx);
  try {
    const res = await synth.run({
      mode: 'synthesize',
      prompt: securitySynthPrompt(plan, audits),
      cwd: winner.path,
      system: composeSystem(synth.preset, 'synthesize'),
      timeoutMs: synth.timeoutMs
    });
    const raw = extractJsonBlock<{ findings?: RawFinding[]; summary?: string }>(res.stdout);
    // A parseable synth result that omits `findings` means "clean" → []. Only fall
    // back to the raw union of every lane's findings when the synth output is wholly
    // unparseable (raw === null) — otherwise the synth's dedup/false-positive
    // filtering is silently discarded and FPs resurface.
    findings = raw ? coerceFindings(raw.findings ?? []) : audits.flatMap((a) => a.findings);
    summary = String(raw?.summary ?? '');
  } catch {
    findings = audits.flatMap((a) => a.findings);
  }

  const { highestSeverity: worstSeverity, passed } = securityVerdict(findings);
  const audit: SecurityAudit = { findings, highestSeverity: worstSeverity, passed, summary, auditors: audits.length };

  if (passed) {
    ctx.logger.info(chalk.green(`\n🔒 Security audit PASSED — no high/critical findings (${findings.length} lower-severity note(s), ${audits.length} auditors).`));
  } else {
    ctx.logger.warn(colorBySeverity(worstSeverity)(`\n🔒 Security audit FAILED — ${worstSeverity} severity finding(s):`));
    for (const f of findings.filter((x) => RANK[x.severity] >= RANK.high)) {
      ctx.logger.warn(colorBySeverity(f.severity)(`   [${f.severity}/${f.category}] ${f.location}: ${f.detail}`));
    }
  }
  return audit;
}

function colorBySeverity(s: Severity): (msg: string) => string {
  if (s === 'critical' || s === 'high') return chalk.red;
  if (s === 'medium') return chalk.yellow;
  return chalk.gray;
}
