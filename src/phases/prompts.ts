import { PanglossPlan, QA, TargetManifest } from '../types.js';

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

  const intro = revision
    ? `Your worktree ALREADY CONTAINS a working implementation — the winner chosen last round. IMPROVE it by applying the revision plan below; do NOT rewrite from scratch, and preserve what already passes.`
    : `Implement the following plan in your current worktree.`;

  return `${intro} Follow the Worktree Contract in your system prompt exactly.

PLAN:
${JSON.stringify(plan, null, 2)}

VALIDATION COMMANDS (run these to check your work; iterate until green):
${cmds || '(none configured)'}
${feedbackSection}
Requirements:
1. Implement every step and satisfy every acceptance criterion.
2. Add or update tests that prove the acceptance criteria.
3. Run the build and tests; fix failures.
4. Commit your work in this worktree.
5. Write ./.pangloss/agent-status.json with your honest final status (see contract).

Begin now.`;
}

export function reviewPrompt(args: {
  plan: PanglossPlan;
  candidateId: string;
  summary: string;
  build: string;
  tests: string;
  diffStat: string;
  diff: string;
}): string {
  return `You are reviewing one candidate implementation of a shared plan,
READ-ONLY. Be rigorous and fair — you will review every candidate (including any
of your own) under the same rubric.

PLAN & ACCEPTANCE CRITERIA:
${JSON.stringify(args.plan, null, 2)}

CANDIDATE: ${args.candidateId}
SELF-REPORTED SUMMARY: ${args.summary || '(none)'}
VALIDATION: build=${args.build}, tests=${args.tests}
DIFF STAT: ${args.diffStat || '(none)'}

UNIFIED DIFF (may be truncated):
\`\`\`diff
${args.diff}
\`\`\`

Assess: Does it satisfy the acceptance criteria? Is it correct, complete, and
well-tested? What did it get uniquely right (novel ideas worth preserving)? What
did it miss? What is still needed?

Return ONLY a JSON object matching this schema (no markdown, no prose):
${REVIEW_SCHEMA}`;
}
