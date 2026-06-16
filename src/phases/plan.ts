import prompts from 'prompts';
import chalk from 'chalk';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { AgentAdapter } from '../agents/adapter.js';
import { composeSystem } from '../agents/contract.js';
import { RunContext } from '../context.js';
import { PanglossPlan, QA } from '../types.js';
import { extractJsonBlock } from '../util/extract.js';
import { mapPool } from '../util/pool.js';
import * as P from './prompts.js';

interface RawPlan {
  summary?: string;
  scope?: string[];
  steps?: string[];
  acceptance_criteria?: string[];
}

/** Phase 1: N agents draft plans independently; a rotating synthesizer merges them. */
export async function runPlanPhase(ctx: RunContext): Promise<PanglossPlan> {
  ctx.logger.phase('Phase 1 — Plan: diverse drafts + rotated synthesis');

  const request = await resolveRequest(ctx);
  const clarifications = await collectClarifications(ctx, request);

  // --- Diverse drafts ---
  ctx.logger.info(`Drafting plans with ${ctx.adapters.length} agents…`);
  const drafts = (
    await mapPool(ctx.adapters, ctx.config.max_parallel_agents, async (adapter) => {
      const res = await adapter.run({
        mode: 'plan',
        prompt: P.planDraftPrompt(request, clarifications),
        cwd: ctx.repoRoot,
        system: composeSystem(adapter.preset, 'plan'),
        timeoutMs: ctx.timeoutMs
      });
      const raw = extractJsonBlock<RawPlan>(res.stdout);
      if (!raw) {
        ctx.logger.agent(adapter.id, chalk.yellow('draft failed to parse — skipped'));
        return null;
      }
      ctx.logger.agent(adapter.id, chalk.green('draft ready'));
      return coercePlan(raw, request, clarifications, adapter.id, ctx.round);
    })
  ).filter((p): p is PanglossPlan => p !== null);

  if (drafts.length === 0) {
    throw new Error('No agent produced a parseable plan draft.');
  }

  // --- Rotated synthesis ---
  const synth = pickSynthesizer(ctx);
  ctx.logger.info(`Synthesizing ${drafts.length} drafts via ${chalk.bold(synth.label)} (rotating seat)…`);
  let plan = await synthesize(ctx, synth, request, clarifications, drafts);

  // --- Human approval gate ---
  plan = await approvalGate(ctx, synth, plan);

  await persistPlan(ctx, request, clarifications, drafts, plan);
  return plan;
}

async function resolveRequest(ctx: RunContext): Promise<string> {
  if (ctx.request && ctx.request.trim()) return ctx.request.trim();
  if (!ctx.interactive) {
    throw new Error('A feature request is required (pass --request "…" in non-interactive mode).');
  }
  const res = await prompts({
    type: 'text',
    name: 'request',
    message: 'What change do you want to make?',
    validate: (v: string) => (v.trim().length > 0 ? true : 'Request is required')
  });
  if (!res.request) throw new Error('Operation cancelled.');
  return res.request.trim();
}

async function collectClarifications(ctx: RunContext, request: string): Promise<QA[]> {
  if (!ctx.interactive || ctx.autoApprove) return [];

  const synth = pickSynthesizer(ctx);
  const res = await synth.run({
    mode: 'plan',
    prompt: P.clarifyPrompt(request),
    cwd: ctx.repoRoot,
    system: composeSystem(synth.preset, 'plan'),
    timeoutMs: ctx.timeoutMs
  });
  const questions = extractJsonBlock<string[]>(res.stdout);
  if (!Array.isArray(questions) || questions.length === 0) return [];

  console.log(chalk.cyan('\nA few clarifying questions (press Enter to skip any):'));
  const answers: QA[] = [];
  for (const question of questions.slice(0, 5)) {
    const a = await prompts({ type: 'text', name: 'value', message: String(question) });
    if (a.value && String(a.value).trim()) {
      answers.push({ question: String(question), answer: String(a.value).trim() });
    }
  }
  return answers;
}

async function synthesize(
  ctx: RunContext,
  synth: AgentAdapter,
  request: string,
  clarifications: QA[],
  drafts: PanglossPlan[]
): Promise<PanglossPlan> {
  const res = await synth.run({
    mode: 'synthesize',
    prompt: P.synthesizePrompt(request, clarifications, drafts),
    cwd: ctx.repoRoot,
    system: composeSystem(synth.preset, 'synthesize'),
    timeoutMs: ctx.timeoutMs
  });
  const raw = extractJsonBlock<RawPlan>(res.stdout);
  if (!raw) {
    ctx.logger.warn('Synthesis output unparseable; falling back to the first draft.');
    return drafts[0];
  }
  return coercePlan(raw, request, clarifications, synth.id, ctx.round);
}

async function approvalGate(ctx: RunContext, synth: AgentAdapter, plan: PanglossPlan): Promise<PanglossPlan> {
  if (ctx.autoApprove || !ctx.interactive) {
    displayPlan(plan);
    ctx.logger.info(chalk.gray('Auto-approved (non-interactive).'));
    return plan;
  }

  let current = plan;
  for (;;) {
    displayPlan(current);
    const action = await prompts({
      type: 'select',
      name: 'value',
      message: 'Approve this synthesized plan?',
      choices: [
        { title: 'Approve', value: 'approve' },
        { title: 'Request changes', value: 'revise' },
        { title: 'Abort', value: 'abort' }
      ]
    });

    if (action.value === 'approve') return current;
    if (action.value === 'abort' || action.value === undefined) {
      throw new Error('Planning aborted by user.');
    }
    const fb = await prompts({ type: 'text', name: 'feedback', message: 'What should change?' });
    const res = await synth.run({
      mode: 'synthesize',
      prompt: P.reviseSynthesisPrompt(current, String(fb.feedback ?? '')),
      cwd: ctx.repoRoot,
      system: composeSystem(synth.preset, 'synthesize'),
      timeoutMs: ctx.timeoutMs
    });
    const raw = extractJsonBlock<RawPlan>(res.stdout);
    if (raw) current = coercePlan(raw, current.original_request, current.clarifications, synth.id, ctx.round);
    else ctx.logger.warn('Revision unparseable; keeping previous plan.');
  }
}

export function pickSynthesizer(ctx: RunContext): AgentAdapter {
  const rotation = ctx.config.synth_rotation?.length
    ? ctx.config.synth_rotation
    : ctx.adapters.map((a) => a.id);
  const id = rotation[ctx.round % rotation.length];
  return ctx.adapters.find((a) => a.id === id) ?? ctx.adapters[ctx.round % ctx.adapters.length];
}

function coercePlan(
  raw: RawPlan,
  request: string,
  clarifications: QA[],
  by: string,
  round: number
): PanglossPlan {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  return {
    summary: raw.summary ? String(raw.summary) : '(no summary)',
    scope: arr(raw.scope),
    steps: arr(raw.steps),
    acceptance_criteria: arr(raw.acceptance_criteria),
    original_request: request,
    clarifications,
    synthesized_by: by,
    round
  };
}

function displayPlan(plan: PanglossPlan): void {
  console.log(chalk.bold('\n📋 Synthesized Plan') + chalk.gray(` (by ${plan.synthesized_by})`));
  console.log(chalk.gray('────────────────────────────────────────'));
  console.log(chalk.bold('Summary: ') + plan.summary);
  console.log(chalk.bold('\nScope:'));
  plan.scope.forEach((s) => console.log(`  • ${s}`));
  console.log(chalk.bold('\nSteps:'));
  plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log(chalk.bold('\nAcceptance criteria:'));
  plan.acceptance_criteria.forEach((c) => console.log(`  ✅ ${c}`));
  console.log(chalk.gray('────────────────────────────────────────'));
}

async function persistPlan(
  ctx: RunContext,
  request: string,
  clarifications: QA[],
  drafts: PanglossPlan[],
  plan: PanglossPlan
): Promise<void> {
  const dir = ctx.runDir;
  await mkdir(join(dir, 'drafts'), { recursive: true });
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  await writeFile(join(dir, 'plan.md'), planToMarkdown(plan));
  await writeFile(join(dir, 'answers.json'), JSON.stringify({ request, clarifications }, null, 2));
  await Promise.all(
    drafts.map((d) => writeFile(join(dir, 'drafts', `${d.synthesized_by}.json`), JSON.stringify(d, null, 2)))
  );
}

export function planToMarkdown(plan: PanglossPlan): string {
  return `# Implementation Plan

_Synthesized by ${plan.synthesized_by} (round ${plan.round ?? 0})_

## Summary
${plan.summary}

## Scope
${plan.scope.map((s) => `- ${s}`).join('\n')}

## Steps
${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Acceptance Criteria
${plan.acceptance_criteria.map((c) => `- [ ] ${c}`).join('\n')}

## Original Request
> ${plan.original_request}

## Clarifications
${plan.clarifications.map((qa) => `**Q:** ${qa.question}\n**A:** ${qa.answer}`).join('\n\n') || '_none_'}
`;
}
