import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverConventionDocs, formatConventionDocs, splitGuide } from '../src/conventions-sources.js';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'conv-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe('discoverConventionDocs', () => {
  it('finds known convention files at root, docs/, and .github/', () => {
    const dir = tempRepo({
      'CONTRIBUTING.md': 'contribute rules',
      'CLAUDE.md': 'claude project rules',
      'README.md': 'not a conventions file',
      'docs/STYLE.md': 'style rules',
      'src/index.ts': 'code'
    });
    const docs = discoverConventionDocs(dir);
    const paths = docs.map((d) => d.path).sort();
    expect(paths).toContain('CONTRIBUTING.md');
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('docs/STYLE.md');
    expect(paths).not.toContain('README.md');
    expect(formatConventionDocs(docs)).toContain('style rules');
  });

  it('returns [] when no convention docs are present', () => {
    const dir = tempRepo({ 'README.md': 'x', 'src/a.ts': 'y' });
    expect(discoverConventionDocs(dir)).toEqual([]);
  });
});

describe('splitGuide', () => {
  it('takes section 1 as the condensed head, splitting before the top-level "2."', () => {
    const full = `# Conventions
1. Critical — always applies
   1.1. Scope every query by company
   1.2. Validate inputs with zod
2. Data
   2.1. Insert idempotently`;
    const { full: f, condensed } = splitGuide(full);
    expect(condensed).toContain('1.1. Scope every query by company');
    expect(condensed).not.toContain('2.1. Insert idempotently');
    expect(f).toContain('2.1. Insert idempotently');
  });

  it('falls back to a truncated head when there is no "2." section', () => {
    const { condensed } = splitGuide('# Conventions\n1. Only one section here');
    expect(condensed).toContain('Only one section here');
  });
});
