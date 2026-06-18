import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import chalk from 'chalk';
import { AgentAdapter } from '../agents/adapter.js';
import { composeSystem } from '../agents/contract.js';
import { RunContext } from '../context.js';
import { gatherReviewCorpus, gitLog } from '../review-corpus.js';
import { reviewPatternsPrompt } from './prompts.js';
import { pickSynthesizer } from './plan.js';

/**
 * Learn a team's CODE-REVIEW TASTE from its git history so reviewers flag the
 * same things the team historically catches (tenancy scoping, idempotency,
 * soft-delete handling, schema validation, dead-code hygiene, …) rather than
 * generic advice. Distilled once per repo and cached under .pangloss/.
 */

const CACHE_REL = join('.pangloss', 'review-patterns.json');

interface PatternsCache {
  sha: string;
  commits: number;
  source: string;
  checklist: string;
}

/** Distill a corpus of commit messages into a reviewer checklist (markdown). */
export async function distillReviewPatterns(
  adapter: AgentAdapter,
  corpus: string,
  timeoutMs: number
): Promise<string> {
  const res = await adapter.run({
    mode: 'review',
    prompt: reviewPatternsPrompt(corpus),
    cwd: process.cwd(),
    system: composeSystem(adapter.preset, 'review'),
    timeoutMs
  });
  return stripFence(res.stdout.trim());
}

function stripFence(s: string): string {
  const m = s.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : s).trim();
}

/**
 * Learn (or load cached) team review patterns for the run's repo. Returns null
 * when disabled (config.review_patterns === false) or no history is available.
 */
export async function learnReviewPatterns(ctx: RunContext): Promise<string | null> {
  if (ctx.config.review_patterns === false) return null;
  const cachePath = join(ctx.repoRoot, CACHE_REL);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as PatternsCache;
      if (cached.checklist?.trim()) {
        ctx.logger.info(chalk.gray(`Using cached team review patterns (${cached.commits} ${cached.source} commits).`));
        return cached.checklist;
      }
    } catch {
      /* fall through and recompute */
    }
  }

  const corpus = await gatherReviewCorpus(ctx.repoRoot);
  if (!corpus.text) {
    ctx.logger.info(chalk.gray('No git history to learn review patterns from — using generic review.'));
    return null;
  }

  ctx.logger.phase('Phase 2.5 — Profile the team’s review taste from git history');
  const synth = pickSynthesizer(ctx);
  ctx.logger.info(`Distilling ${corpus.count} ${corpus.source} commits via ${chalk.bold(synth.label)}…`);
  let checklist = '';
  try {
    checklist = await distillReviewPatterns(synth, corpus.text, synth.timeoutMs);
  } catch (err) {
    ctx.logger.warn(`Review-pattern distillation failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!checklist) return null;

  const head = (await gitLog(ctx.repoRoot, ['rev-parse', 'HEAD'])).trim();
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({ sha: head, commits: corpus.count, source: corpus.source, checklist }, null, 2)
  );
  ctx.logger.info(chalk.green(`✓ Learned this team’s review profile (${corpus.count} commits).`));
  return checklist;
}
