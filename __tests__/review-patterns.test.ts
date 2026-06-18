import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gatherReviewCorpus } from '../src/review-corpus.js';

function repoWith(subjects: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: 'pipe' });
  git('init -q');
  git('config user.email t@t.co');
  git('config user.name test');
  subjects.forEach((s, i) => {
    writeFileSync(join(dir, `f${i}.txt`), String(i));
    git('add -A');
    execSync(`git commit -q -m ${JSON.stringify(s)}`, { cwd: dir, stdio: 'pipe' });
  });
  return dir;
}

describe('gatherReviewCorpus', () => {
  it('prefers review-scoped commits and includes their subjects', async () => {
    const dir = repoWith([
      'feat: add thing',
      'fix(review): scope query per company',
      'fix(review): idempotent insert on 23505',
      'chore: bump deps'
    ]);
    const corpus = await gatherReviewCorpus(dir);
    expect(corpus.count).toBeGreaterThan(0);
    expect(corpus.text).toContain('scope query per company');
    expect(corpus.text).toContain('idempotent insert on 23505');
    expect(['review', 'review+fix', 'fix']).toContain(corpus.source);
  });

  it('falls back to recent subjects when there are no fix/review commits', async () => {
    const dir = repoWith(['feat: a', 'feat: b', 'docs: c']);
    const corpus = await gatherReviewCorpus(dir);
    expect(corpus.source).toBe('recent');
    expect(corpus.text).toContain('feat: a');
  });
});
