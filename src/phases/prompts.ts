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

export function planDraftPrompt(request: string, clarifications: QA[]): string {
  return `You are drafting an implementation plan. Inspect the repository in your
current directory (read-only) and design the best plan you can.

REQUEST:
"${request}"

CLARIFICATIONS:
${qaBlock(clarifications)}

Write a plan that is specific to THIS codebase: name real files, real commands,
and concrete acceptance criteria that a test could verify. Bring your own best
judgment — other agents are drafting independently and the strongest ideas win.

Return ONLY a JSON object matching this schema (no markdown, no prose):
${PLAN_SCHEMA}`;
}

export function synthesizePrompt(request: string, clarifications: QA[], drafts: PanglossPlan[]): string {
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

DRAFTS:
${draftBlock}

Return ONLY a JSON object matching this schema (no markdown, no prose):
${PLAN_SCHEMA}`;
}

export function acceptanceDraftPrompt(plan: PanglossPlan, dir: string): string {
  return `You are writing the ACCEPTANCE TESTS that will define "done" for the plan
below — the objective gate every implementation must pass. Inspect the repository
(read-only) FIRST: identify the test framework, conventions, and the exact import
paths/modules these tests must exercise.

PLAN & ACCEPTANCE CRITERIA:
${JSON.stringify(plan, null, 2)}

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
  opts: { feedbackTail?: string; revision?: boolean } = {}
): string {
  const { feedbackTail, revision } = opts;
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

  return `${intro} Follow the Worktree Contract in your system prompt exactly.

PLAN:
${JSON.stringify(plan, null, 2)}

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

export function reviewPatternsPrompt(corpus: string): string {
  return `You are profiling a software team's CODE-REVIEW TASTE from their git history.
Below are commit messages from their review follow-ups and fixes — the things this
team repeatedly catches and corrects. Distill the RECURRING, codebase-specific
concerns into a concise checklist a reviewer should apply to NEW code in THIS repo.

Rules:
- 6–12 themed groups. Each: a short bold name + 1 line on what to look for.
- Be specific to the evidence (e.g. tenancy/mode scoping, idempotency & replay-safety,
  soft-delete handling, schema validation over casts, dead/stale-code hygiene, auth in
  middleware, test coverage of new paths). Avoid generic advice not supported by the commits.
- No preamble, no conclusion — just the checklist.

COMMIT MESSAGES:
${corpus}

Return a compact markdown checklist.`;
}

export function reviewPrompt(args: {
  plan: PanglossPlan;
  candidateLabel: string;
  summary: string;
  build: string;
  tests: string;
  diffStat: string;
  diff: string;
  /** This team's review taste, learned from git history. */
  teamPatterns?: string | null;
  /** Acceptance-gate audit for this candidate (when the gate is on). */
  acceptance?: { verdict: string; passedVsCanonical: number; total: number; modified: boolean } | null;
}): string {
  const patternsSection = args.teamPatterns
    ? `\nTEAM REVIEW PATTERNS (learned from THIS repo's history — apply them; these are the things this team consistently catches):\n${args.teamPatterns}\n`
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
