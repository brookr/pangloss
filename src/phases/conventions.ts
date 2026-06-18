import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import chalk from 'chalk';
import { composeSystem } from '../agents/contract.js';
import { RunContext } from '../context.js';
import { gatherReviewCorpus } from '../review-corpus.js';
import { discoverConventionDocs, formatConventionDocs, splitGuide } from '../conventions-sources.js';
import { conventionsPrompt } from './prompts.js';
import { pickSynthesizer } from './plan.js';
import { Conventions } from '../types.js';

const CACHE_REL = join('.pangloss', 'conventions.md');

/**
 * Phase 0 — establish ONE project conventions guide, fusing the repo's DOCUMENTED
 * conventions (authoritative, take precedence) with patterns LEARNED from its git
 * history (supplementary, fill gaps only). Cached under .pangloss/. Consumed by
 * planning, acceptance, coding, and review. Returns null when disabled or there's
 * nothing to learn from.
 */
export async function establishConventions(ctx: RunContext): Promise<Conventions | null> {
  if (ctx.config.conventions === false) return null;

  const cachePath = join(ctx.repoRoot, CACHE_REL);
  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath, 'utf8').trim();
    if (cached) {
      ctx.logger.info(chalk.gray('Using cached project conventions guide.'));
      return splitGuide(cached);
    }
  }

  const docs = discoverConventionDocs(ctx.repoRoot);
  const corpus = await gatherReviewCorpus(ctx.repoRoot);
  if (docs.length === 0 && !corpus.text) {
    ctx.logger.info(chalk.gray('No conventions docs or git history found — skipping conventions guide.'));
    return null;
  }

  ctx.logger.phase('Phase 0 — Conventions: establish the project’s engineering conventions');
  if (docs.length) ctx.logger.info(chalk.gray(`Documented: ${docs.map((d) => d.path).join(', ')} (authoritative)`));
  if (corpus.text) ctx.logger.info(chalk.gray(`Observed: ${corpus.count} ${corpus.source} commit(s) (supplementary)`));

  const synth = pickSynthesizer(ctx);
  ctx.logger.info(`Synthesizing the conventions guide via ${chalk.bold(synth.label)}…`);
  let guide = '';
  try {
    const res = await synth.run({
      mode: 'synthesize',
      prompt: conventionsPrompt(formatConventionDocs(docs), corpus.text),
      cwd: ctx.repoRoot,
      system: composeSystem(synth.preset, 'synthesize'),
      timeoutMs: synth.timeoutMs
    });
    guide = stripFence(res.stdout.trim());
  } catch (err) {
    ctx.logger.warn(`Conventions synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!guide) return null;

  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, guide + '\n');
  ctx.logger.info(chalk.green(`✓ Conventions guide ready (${docs.length} documented, ${corpus.count} observed).`));
  return splitGuide(guide);
}

function stripFence(s: string): string {
  const m = s.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  let out = (m ? m[1] : s).trim();
  // Drop any model preamble before the first markdown heading.
  const h = out.search(/^#\s/m);
  if (h > 0) out = out.slice(h).trim();
  return out;
}
