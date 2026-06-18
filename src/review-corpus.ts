import { run } from './util/proc.js';

/**
 * Pure git-history gathering for the review-pattern learner — kept free of any
 * heavy/ESM deps (chalk, adapters) so it's unit-testable in isolation.
 */

const MAX_CORPUS = 16000;
const SEP = '';

export async function gitLog(repoRoot: string, args: string[]): Promise<string> {
  const r = await run('git', args, { cwd: repoRoot, timeoutMs: 30_000 });
  return r.ok ? r.stdout : '';
}

/**
 * Gather a corpus of the team's review-driven commits. Prefers explicit review
 * follow-ups (`fix(review)` etc.) with bodies; broadens to all `fix` subjects,
 * then recent subjects, so it works on any repo.
 */
export async function gatherReviewCorpus(
  repoRoot: string
): Promise<{ text: string; count: number; source: string }> {
  const withBodies = await gitLog(repoRoot, [
    'log',
    '-i',
    '--grep=fix(review)',
    '--grep=review):',
    '--grep=address review',
    '--grep=pr feedback',
    `--pretty=format:%s%n%b${SEP}`,
    '-n',
    '150'
  ]);
  let entries = withBodies
    .split(SEP)
    .map((s) => s.trim())
    .filter(Boolean);
  let source = 'review';

  if (entries.length < 12) {
    const fixes = await gitLog(repoRoot, ['log', '-i', '--grep=^fix', '--pretty=format:%s', '-n', '300']);
    const subs = fixes.split('\n').map((s) => s.trim()).filter(Boolean);
    entries = [...entries, ...subs];
    source = entries.length === subs.length ? 'fix' : 'review+fix';
  }
  if (entries.length === 0) {
    const recent = await gitLog(repoRoot, ['log', '--pretty=format:%s', '-n', '200']);
    entries = recent.split('\n').map((s) => s.trim()).filter(Boolean);
    source = 'recent';
  }
  if (entries.length === 0) return { text: '', count: 0, source: 'none' };

  return { text: dedupeLines(entries).join('\n').slice(0, MAX_CORPUS), count: entries.length, source };
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const key = l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}
