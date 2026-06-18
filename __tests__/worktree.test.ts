import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorktreeManager } from '../src/worktree.js';

/** Spin up a throwaway git repo and return its path. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-test-'));
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: 'pipe' });
  git('init -q');
  git('config user.email t@t.co');
  git('config user.name test');
  return dir;
}

describe('WorktreeManager.treesIdentical', () => {
  it('is true for a ref against itself, and across commits with identical content', async () => {
    const dir = tempRepo();
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: 'pipe' });
    const sha = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir }).toString().trim();

    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    git('add -A');
    git('commit -q -m one');
    const c1 = sha('rev-parse HEAD');

    // A second commit that ends at the SAME tree (change then revert) — different
    // commit sha, identical content. The revise short-circuit must treat this as
    // "no change", so the comparison has to be tree-based, not sha-based.
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    git('add -A');
    git('commit -q -m two');
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    git('add -A');
    git('commit -q -m three');
    const c3 = sha('rev-parse HEAD');

    const wm = new WorktreeManager(dir, 'test-run');
    expect(c1).not.toEqual(c3);
    expect(await wm.treesIdentical(c1, c1)).toBe(true);
    expect(await wm.treesIdentical(c1, c3)).toBe(true);
  });

  it('is false when the trees differ', async () => {
    const dir = tempRepo();
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: 'pipe' });
    const sha = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir }).toString().trim();

    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add -A');
    git('commit -q -m one');
    const c1 = sha('rev-parse HEAD');

    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git('add -A');
    git('commit -q -m two');
    const c2 = sha('rev-parse HEAD');

    const wm = new WorktreeManager(dir, 'test-run');
    expect(await wm.treesIdentical(c1, c2)).toBe(false);
  });
});
