import { PanglossPlan, QA, TargetManifest } from '../types.js';
import { acceptanceDir } from '../acceptance.js';

const PLAN_SCHEMA = `{
  "summary": "1-2 sentence description of the change",
  "scope": ["files or components expected to change"],
  "steps": ["ordered, concrete implementation steps"],
  "acceptance_criteria": ["testable conditions that prove the feature works"]
}`;

const REVIEW_SCHEMA = `{
  "overall_score": 0-100,
  "meets_acceptance_criteria": true | false,
  "sub_scores": {
    "correctness": 0-100,
    "completeness": 0-100,
    "code_quality": 0-100,
    "test_quality": 0-100,
    "maintainability": 0-100
  },
  "novel_ideas": ["genuinely novel, sound ideas in THIS implementation worth keeping"],
  "gaps": ["what this implementation missed or got wrong"],
  "still_needed": ["what is still required to fully satisfy the plan"],
  "must_fix": ["critical bugs or plan violations that must be addressed"],
  "confidence": 0.0-1.0
}`;

const acceptanceSchema = (dir: string) => `{
  "files": [
    { "path": "${dir}/<descriptive-name>.test.<ext>", "content": "<COMPLETE runnable test file source>" }
  ],
  "criteria_covered": ["which acceptance_criteria each test verifies"]
}`;

function qaBlock(clarifications: QA[]): string {
  if (!clarifications.length) return '(no clarifications were collected)';
  return clarifications.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join('\n\n');
}

export function clarifyPrompt(request: string): string {
  return `A user wants to make this change to the codebase in your current directory:

"${request}"

Inspect the repository as needed (read-only). Produce 3-5 sharp clarifying
questions whose answers would most change the implementation — architecture,
edge cases, scope boundaries, and how success is tested.

Return ONLY a JSON array of question strings, e.g. ["...", "..."]. No prose.`;
}

export function planDraftPrompt(request: string, clarifications: QA[], conventions?: string | null): string {
  return `You are drafting an implementation plan. Inspect the repository in your
current directory (read-only) and design the best plan you can.

REQUEST:
"${request}"

CLARIFICATIONS:
${qaBlock(clarifications)}
${conventionsBlock(conventions)}
Write a plan that is specific to THIS codebase: name real files, real commands,
and concrete acceptance criteria that a test could verify. Fold the project
conventions into your steps and acceptance_criteria (e.g. scoping, validation,
coverage). Bring your own best judgment — other agents are drafting independently
and the strongest ideas win.

Return ONLY a JSON object matching this schema (no markdown, no prose):
${PLAN_SCHEMA}`;
}

function conventionsBlock(conventions?: string | null): string {
  return conventions ? `\nPROJECT CONVENTIONS (this codebase's established rules — honor them):\n${conventions}\n` : '';
}

export function synthesizePrompt(
  request: string,
  clarifications: QA[],
  drafts: PanglossPlan[],
  conventions?: string | null
): string {
  const draftBlock = drafts
    .map((d, i) => `### Draft ${i + 1} (by ${d.synthesized_by ?? 'agent'})\n${JSON.stringify(d, null, 2)}`)
    .join('\n\n');

  return `You are the SYNTHESIZER. Several agents independently drafted plans for
the same request. Merge them into ONE superior plan — the best of all possible
worlds. Adopt the strongest idea from each draft, reconcile conflicts in favor
of correctness and simplicity, drop redundancy, and fill gaps none of them
covered. Inspect the repository (read-only) to keep it grounded in reality.

REQUEST:
"${request}"

CLARIFICATIONS:
${qaBlock(clarifications)}
${conventionsBlock(conventions)}
DRAFTS:
${draftBlock}

Return ONLY a JSON object matching this schema (no markdown, no prose):
${PLAN_SCHEMA}`;
}

export function acceptanceDraftPrompt(plan: PanglossPlan, dir: string, conventions?: string | null): string {
  return `You are writing the ACCEPTANCE TESTS that will define "done" for the plan
below — the objective gate every implementation must pass. Inspect the repository
(read-only) FIRST: identify the test framework, conventions, and the exact import
paths/modules these tests must exercise.

PLAN & ACCEPTANCE CRITERIA:
${JSON.stringify(plan, null, 2)}
${conventions ? `\nPROJECT CONVENTIONS — encode the TESTABLE ones as acceptance tests too (e.g. tenancy scoping, validation/rejection, ordering/caps), not just the plan's criteria:\n${conventions}\n` : ''}
Write executable tests, in the repo's existing framework, that:
- Verify EACH acceptance criterion concretely (specific inputs → specific expected outputs). Prefer strict matchers (exact equality), not loose truthiness.
- Exercise the REAL code/modules under test via their real import paths — not mocks of the thing being built.
- MUST FAIL on the current code (the feature isn't implemented yet). You are encoding the target behavior, not the present behavior.
- Live entirely under the "${dir}/" directory.

Return ONLY a JSON object matching this schema (no markdown, no prose):
${acceptanceSchema(dir)}`;
}

export function acceptanceSynthPrompt(plan: PanglossPlan, dir: string, drafts: unknown[]): string {
  const block = drafts.map((d, i) => `### Draft ${i + 1}\n${JSON.stringify(d, null, 2)}`).join('\n\n');
  return `You are the SYNTHESIZER for the ACCEPTANCE TESTS. Several agents drafted
test suites for the same plan. Merge them into ONE canonical suite — the strongest,
most complete gate. Keep the strictest assertion for each behavior, cover every
acceptance criterion, drop duplicates and anything that doesn't map to a criterion,
and ensure the tests would FAIL on the current (unimplemented) code. Inspect the
repository (read-only) to keep import paths and framework usage correct.

PLAN & ACCEPTANCE CRITERIA:
${JSON.stringify(plan, null, 2)}

DRAFT TEST SUITES:
${block}

Return ONLY a JSON object matching this schema (no markdown, no prose):
${acceptanceSchema(dir)}`;
}

export function reviseSynthesisPrompt(plan: PanglossPlan, feedback: string): string {
  return `Revise this implementation plan based on the user's feedback. Keep what
works; change only what the feedback asks for.

CURRENT PLAN:
${JSON.stringify(plan, null, 2)}

USER FEEDBACK:
"${feedback}"

Return ONLY a JSON object matching the same schema (no markdown, no prose):
${PLAN_SCHEMA}`;
}

export function revisionPlanPrompt(
  plan: PanglossPlan,
  brief: { mustFix: string[]; adoptFromOthers: string[]; stillNeeded: string[] },
  round: number
): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)');
  return `You are producing a focused REVISION PLAN for round ${round}. A winning
implementation was selected last round and now sits in every agent's worktree.
Cross-model review produced the brief below. Synthesize the specific changes to
make to that winning implementation — fix the must-fix items, graft in the
strongest novel ideas from the other candidates, and cover anything still
needed. Preserve what already works; do NOT redesign from scratch.

ORIGINAL PLAN & ACCEPTANCE CRITERIA:
${JSON.stringify(plan, null, 2)}

REVISION BRIEF
Must fix:
${list(brief.mustFix)}
Adopt from other candidates (novel ideas worth grafting in):
${list(brief.adoptFromOthers)}
Still needed:
${list(brief.stillNeeded)}

Return ONLY a JSON object matching this schema, where steps/scope describe the
REVISIONS to apply (no markdown, no prose):
${PLAN_SCHEMA}`;
}

export function codePrompt(
  plan: PanglossPlan,
  manifest: TargetManifest,
  opts: { feedbackTail?: string; revision?: boolean; conventions?: string | null } = {}
): string {
  const { feedbackTail, revision, conventions } = opts;
  const cmds = [
    manifest.setup ? `- setup:  ${manifest.setup} (dependencies may already be installed)` : null,
    manifest.build ? `- build:  ${manifest.build}` : null,
    manifest.test ? `- test:   ${manifest.test}` : null,
    manifest.e2e ? `- e2e:    ${manifest.e2e}` : null
  ]
    .filter(Boolean)
    .join('\n');

  const feedbackSection = feedbackTail
    ? `\nA previous attempt left failures. Fix them. Latest validation output (tail):\n\`\`\`\n${feedbackTail}\n\`\`\`\n`
    : '';

  const acceptanceSection = manifest.acceptanceCmd
    ? `\nACCEPTANCE GATE — the tests under "${acceptanceDir(manifest.acceptanceDir)}/" define "done". Run them with:
- acceptance: ${manifest.acceptanceCmd}
Make ALL of them pass. You MAY refine an acceptance test ONLY to correct a genuinely wrong expectation (e.g. it asserts the wrong value or a mistaken API shape) — and you must explain why in your status notes. Your implementation is ALSO graded against the ORIGINAL acceptance suite, so weakening a test (removing/loosening assertions to make a broken implementation pass) cannot help you and will be penalized. Strengthening or clarifying is welcome.\n`
    : '';

  const intro = revision
    ? `Your worktree ALREADY CONTAINS a working implementation — the winner chosen last round. IMPROVE it by applying the revision plan below; do NOT rewrite from scratch, and preserve what already passes.`
    : `Implement the following plan in your current worktree.`;

  const conventionsSection = conventions
    ? `\nPROJECT CONVENTIONS (write code that follows these from the start — they are how this codebase is built):\n${conventions}\n`
    : '';

  return `${intro} Follow the Worktree Contract in your system prompt exactly.

PLAN:
${JSON.stringify(plan, null, 2)}
${conventionsSection}

VALIDATION COMMANDS (run these to check your work; iterate until green):
${cmds || '(none configured)'}
${acceptanceSection}${feedbackSection}
Requirements:
1. Implement every step and satisfy every acceptance criterion.
2. Add or update tests that prove the acceptance criteria.
3. Run the build and tests; fix failures.
4. Commit your work in this worktree.
5. Write ./.pangloss/agent-status.json with your honest final status (see contract).

Begin now.`;
}

const SECURITY_SCHEMA = `{
  "findings": [
    {
      "severity": "critical | high | medium | low",
      "category": "injection | authz | authn | secrets | ssrf | path-traversal | deserialization | xss | crypto | dos | input-validation | other",
      "location": "file:line or symbol",
      "detail": "the vulnerability and a concrete exploit path",
      "recommendation": "the specific fix"
    }
  ],
  "overall": "one-line security summary"
}`;

export function securityAuditPrompt(plan: PanglossPlan, diff: string, conventions?: string | null, truncated = false): string {
  return `You are a security auditor performing the FINAL security review of a code
change before it ships. Audit ONLY for security — not style, not general
correctness. You are read-only and anonymized.

PLAN & INTENT:
${JSON.stringify({ summary: plan.summary, scope: plan.scope, acceptance_criteria: plan.acceptance_criteria }, null, 2)}
${conventions ? `\nPROJECT SECURITY CONVENTIONS (apply the security-relevant ones):\n${conventions}\n` : ''}${
    truncated
      ? `\nNOTE: the diff below is TRUNCATED — you are seeing only the beginning of the change. Audit what is shown, but do NOT treat the unseen remainder as clean; flag that your view is partial if it matters.\n`
      : ''
  }
THE WINNING CHANGE (unified diff${truncated ? ', truncated' : ''}):
\`\`\`diff
${diff}
\`\`\`

Hunt for vulnerabilities the change INTRODUCES or leaves exposed: injection
(SQL/command/template), broken authz/authn or tenancy scoping, secret/credential
exposure, SSRF, path traversal, unsafe deserialization, XSS, weak crypto, DoS,
and missing validation at trust boundaries. Be specific and exploit-oriented.
Report ONLY real issues with a concrete exploit path — do not pad with generic
advice. If the change is clean, return an empty findings array.

Return ONLY a JSON object matching this schema (no markdown, no prose):
${SECURITY_SCHEMA}`;
}

export function securitySynthPrompt(plan: PanglossPlan, audits: unknown[]): string {
  return `You are the SECURITY LEAD consolidating several independent security audits
of ONE change into a single verdict. Merge the auditors' findings: dedupe the
same issue (keep the HIGHEST severity any auditor gave it), DROP false positives
(a finding the diff does not actually support), and keep only real, exploitable
issues. Do not invent new findings beyond what the auditors raised.

CHANGE INTENT: ${plan.summary}

INDEPENDENT AUDITS:
${JSON.stringify(audits, null, 2)}

Return ONLY a JSON object matching this schema (no markdown, no prose):
{
  "findings": [ { "severity": "critical|high|medium|low", "category": "...", "location": "...", "detail": "...", "recommendation": "..." } ],
  "summary": "the consolidated security verdict in one or two sentences"
}`;
}

export function conventionsPrompt(docsText: string, corpusText: string): string {
  const documented = docsText
    ? `DOCUMENTED CONVENTIONS (AUTHORITATIVE — these take precedence; preserve their rules and intent, and NEVER contradict them):\n${docsText}\n`
    : 'No conventions are documented in the repo yet — build the guide from the observed patterns and codebase reality.\n';
  const observed = corpusText
    ? `\nOBSERVED PATTERNS (learned from this team's review/fix history — SUPPLEMENTARY; add only recurring conventions NOT already covered above, and mark each "(observed)"):\n${corpusText}\n`
    : '';

  return `Write the ENGINEERING CONVENTIONS guide for THIS codebase. It is read by AI
coding agents (senior level) during planning, implementation, and review — not by
humans. Inspect the repository (read-only) to ground every rule in reality.

${documented}${observed}
Optimize for LLM consumption:
- Atomic & imperative: one rule per line, present-tense directive ("Scope every query by company"). No rationale unless it changes the behavior. No preamble, no filler, no walkthroughs.
- Senior audience: omit anything a competent engineer already does by default; only codebase-specific or non-obvious rules earn a line.
- Positive directives only: state what TO do. Do NOT include incorrect code, anti-patterns, or "bad vs good" contrasts; a prohibition is one terse clause, never a demonstration of the wrong way.
- Minimal grounding: cite a real symbol/path/command only when a rule is otherwise ambiguous — a single token, never a snippet.
- Mark a rule sourced only from history with a trailing "(observed)". Where documented and observed conflict, the DOCUMENTED rule wins.

Structure as a numbered hierarchy with STABLE dotted IDs so any rule is citable as "3.2.4". Put the highest-priority, always-applies rules in section 1. Format EXACTLY:

# Conventions
1. Critical — always applies
   1.1. <rule>
   1.2. <rule>
2. <Topic>
   2.1. <rule>
      2.1.1. <sub-rule>
3. <Topic>
   ...

Return only the guide, target under ~450 words.`;
}

export function reviewPrompt(args: {
  plan: PanglossPlan;
  candidateLabel: string;
  summary: string;
  build: string;
  tests: string;
  diffStat: string;
  diff: string;
  /** The project conventions guide. */
  conventions?: string | null;
  /** Acceptance-gate audit for this candidate (when the gate is on). */
  acceptance?: { verdict: string; passedVsCanonical: number; total: number; modified: boolean } | null;
}): string {
  const patternsSection = args.conventions
    ? `\nPROJECT CONVENTIONS (apply them — this is how THIS codebase is built). Flag any violation and CITE its convention number (e.g. "violates 3.2") in gaps/must_fix so it can be fixed precisely:\n${args.conventions}\n`
    : '';

  const acc = args.acceptance;
  const acceptanceSection = acc
    ? `\nACCEPTANCE GATE — the tests under the acceptance/ directory are the spec contract. This candidate ` +
      `passes ${acc.passedVsCanonical}/${acc.total} of the ORIGINAL canonical suite; objective audit verdict: ${acc.verdict}` +
      `${acc.modified ? '' : ' (tests unchanged)'}.\n` +
      `If the diff modifies any acceptance/ test, judge it: did the change CLARIFY/strengthen the contract (fix a wrong ` +
      `expectation, add a case) or WEAKEN it (remove/loosen assertions to pass a broken implementation)? Note exactly what ` +
      `changed and why it is or isn't justified.\n`
    : '';

  const schema = acc
    ? REVIEW_SCHEMA.replace(
        '  "confidence": 0.0-1.0',
        '  "acceptance_tests": { "verdict": "clean | clarified | weakened | unsure", "note": "what changed in the acceptance tests and whether it was justified" },\n  "confidence": 0.0-1.0'
      )
    : REVIEW_SCHEMA;

  return `You are reviewing one candidate implementation of a shared plan,
READ-ONLY. The author is ANONYMIZED — you do not know which agent (or model)
wrote this, and one of these candidates may be your own. Judge only the code
against the rubric; do not speculate about authorship.

PLAN & ACCEPTANCE CRITERIA:
${JSON.stringify(args.plan, null, 2)}
${patternsSection}${acceptanceSection}
CANDIDATE: ${args.candidateLabel}
SELF-REPORTED SUMMARY: ${args.summary || '(none)'}
VALIDATION: build=${args.build}, tests=${args.tests}
DIFF STAT: ${args.diffStat || '(none)'}

UNIFIED DIFF (may be truncated):
\`\`\`diff
${args.diff}
\`\`\`

Assess: Does it satisfy the acceptance criteria? Is it correct, complete, and
well-tested? Apply the team review patterns above. What did it get uniquely right
(novel ideas worth preserving)? What did it miss? What is still needed?

Return ONLY a JSON object matching this schema (no markdown, no prose):
${schema}`;
}
