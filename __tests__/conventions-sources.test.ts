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
  it('splits the condensed head from the full guide on the Conventions heading', () => {
    const full = `## Most important rules
- always scope by tenant
- validate with zod

## Conventions
### Tenancy
detail detail`;
    const { full: f, condensed } = splitGuide(full);
    expect(condensed).toContain('always scope by tenant');
    expect(condensed).not.toContain('### Tenancy');
    expect(f).toContain('### Tenancy');
  });

  it('falls back to a truncated head when there is no marker', () => {
    const { condensed } = splitGuide('just a flat list of rules with no heading');
    expect(condensed).toContain('just a flat list');
  });
});
