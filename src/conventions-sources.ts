import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Discover a repo's DOCUMENTED conventions — the authoritative source the
 * conventions guide is built on (learned-from-history patterns only supplement
 * these). Kept dependency-light so it's unit-testable in isolation.
 */

export interface ConventionDoc {
  path: string;
  content: string;
}

const PER_FILE_CAP = 6000;
const TOTAL_CAP = 18000;

/** Filenames (case-insensitive) that conventionally hold project conventions. */
const NAME_PATTERNS: RegExp[] = [
  /^contributing(\.md)?$/i,
  /^conventions?(\.md)?$/i,
  /^style[-_]?guide(\.md)?$/i,
  /^style(\.md)?$/i,
  /^coding[-_]?standards?(\.md)?$/i,
  /^code[-_]?style(\.md)?$/i,
  /^agents?\.md$/i,
  /^claude\.md$/i,
  /^cursor\.md$/i,
  /^\.cursorrules$/i,
  /^\.editorconfig$/i,
  /^architecture(\.md)?$/i
];

function matches(name: string): boolean {
  return NAME_PATTERNS.some((re) => re.test(name));
}

/** Read matching files at the repo root and one level into a `docs/` dir. */
export function discoverConventionDocs(repoRoot: string): ConventionDoc[] {
  const found: ConventionDoc[] = [];
  const tryDir = (rel: string) => {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      try {
        if (!statSync(p).isFile() || !matches(name)) continue;
        const content = readFileSync(p, 'utf8').slice(0, PER_FILE_CAP).trim();
        if (content) found.push({ path: rel ? `${rel}/${name}` : name, content });
      } catch {
        /* unreadable — skip */
      }
    }
  };
  tryDir('');
  tryDir('docs');
  tryDir('.github');
  return capTotal(found);
}

function capTotal(docs: ConventionDoc[]): ConventionDoc[] {
  const out: ConventionDoc[] = [];
  let used = 0;
  for (const d of docs) {
    if (used >= TOTAL_CAP) break;
    const content = d.content.slice(0, Math.max(0, TOTAL_CAP - used));
    out.push({ ...d, content });
    used += content.length;
  }
  return out;
}

/** Format discovered docs for a prompt. */
export function formatConventionDocs(docs: ConventionDoc[]): string {
  if (!docs.length) return '';
  return docs.map((d) => `### ${d.path}\n${d.content}`).join('\n\n');
}

/**
 * Split a generated guide into a condensed head (for the plan prompt) and the
 * full text (for code/review). The guide is authored with a "## Most important
 * rules" head followed by "## Conventions"; we split on that marker.
 */
export function splitGuide(full: string): { full: string; condensed: string } {
  const marker = /\n#{1,3}\s+conventions\b/i;
  const m = full.match(marker);
  const condensed = m && m.index ? full.slice(0, m.index).trim() : full.slice(0, 1600).trim();
  return { full: full.trim(), condensed: condensed || full.slice(0, 1600).trim() };
}
