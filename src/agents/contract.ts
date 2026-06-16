import { AgentMode, AgentPreset } from '../types.js';

/**
 * The single source of truth for how every heterogeneous agent must behave
 * inside its worktree. This is compiled into dist/ and injected into EVERY
 * agent's system prompt (Claude via --append-system-prompt; others prepended),
 * so it binds regardless of tool and regardless of the agent's cwd.
 *
 * The human/Claude-facing copy lives at
 * `.claude/skills/pangloss-worktree/SKILL.md`; keep the two in sync.
 */
export const WORKTREE_CONTRACT = `# Pangloss Worktree Contract

You are ONE of several AI agents working in parallel on the same task, each in
your own isolated git worktree on your own branch. This contract is how we stay
out of each other's way and produce comparable results. Follow it exactly — the
orchestrator verifies compliance and discards work that violates it.

## Your sandbox
- Your working directory is your worktree. It is the ONLY place you may write.
- Your branch (pangloss/<run_id>/<agent_id>) is already checked out. Stay on it.
- The control directory \`.pangloss/\` inside your worktree is yours to write
  status into. Do not delete it.

## Hard boundaries — never do these (they cause your work to be rejected)
- Never edit, create, or delete files OUTSIDE your worktree directory.
- Never cd out of the worktree to run mutating commands.
- Never run: git worktree …, git checkout <other-branch>, git switch,
  git branch -D, git rebase, git reset --hard <other-ref>, git push,
  git remote …, or git config --global.
- Never touch another agent's worktree, the main checkout, or anything under
  your home directory outside this worktree.
- Never kill processes, containers, or servers you did not start.

You MAY: read anywhere in your own worktree, create/edit/delete files within it,
run builds/tests/linters, install dependencies into the worktree, and commit to
your branch.

## Committing
- Commit inside this worktree only: git add -A && git commit -m "<message>".
- Commit in logical increments; leave a clean final commit.
- Do NOT push. The orchestrator owns all remote operations.

## Signal your status
When you stop, write ./.pangloss/agent-status.json (relative to your worktree
root) with exactly this shape:
{
  "done": true,
  "summary": "1-2 sentences on what you implemented/decided.",
  "remaining_work": ["anything you did NOT finish"],
  "tests": { "build_passed": true, "tests_passed": 0, "tests_failed": 0 },
  "notes_for_reviewers": ["non-obvious choices, tradeoffs, novel ideas"]
}
Set "done": false if you ran out of scope/time. Be honest — a truthful partial
status is worth more than an optimistic one.

## Validate before declaring done
Run the project's configured build and test commands (provided to you). Iterate
until green, or until you've exhausted reasonable attempts, then record the real
state in agent-status.json. Write tests for new behavior and cover the plan's
acceptance criteria. If the target runs a web app, bind any dev server only to
the port you were assigned and never assume the default port is free.

## Mindset
Implement EXACTLY the plan you were given — don't redesign it — but bring your
own best judgment to how. Keep changes minimal and on-scope; gold-plating
outside the plan counts against you in review.`;

const MODE_NOTES: Record<AgentMode, string> = {
  plan: 'You are in PLAN mode: read the codebase as needed, do NOT modify any files. Return only the requested JSON.',
  synthesize:
    'You are in SYNTHESIZE mode: merge the supplied draft plans into one superior plan. Do NOT modify any files. Return only the requested JSON.',
  code: 'You are in CODE mode: implement the plan in your worktree, write tests, and validate. The Worktree Contract above is binding.',
  review:
    'You are in REVIEW mode: assess the implementation READ-ONLY. Do NOT modify any files. Return only the requested JSON.'
};

/**
 * Compose the system/contract text handed to an agent for a given mode. Includes
 * the worktree contract (for write-capable modes), the agent's persona (a lever
 * for behavioral diversity), and a mode-specific reminder.
 */
export function composeSystem(preset: AgentPreset, mode: AgentMode): string {
  const parts: string[] = [];
  // The full contract only matters where the agent can act on the filesystem.
  if (mode === 'code') {
    parts.push(WORKTREE_CONTRACT);
  } else {
    parts.push('You are a Pangloss agent. ' + MODE_NOTES[mode]);
  }
  if (mode === 'code') parts.push(MODE_NOTES[mode]);
  if (preset.persona) parts.push(`## Your persona\n${preset.persona}`);
  return parts.join('\n\n');
}
