import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveProvisions, provisionFiles } from '../src/provision.js';

describe('resolveProvisions', () => {
  it('normalizes paths and resolves from/to against repo and worktree', () => {
    const out = resolveProvisions('/repo', '/wt', ['./apps/web/.env.local', 'a/b/']);
    expect(out.map((p) => p.rel)).toEqual(['apps/web/.env.local', 'a/b']);
    expect(out[0].from).toBe('/repo/apps/web/.env.local');
    expect(out[0].to).toBe('/wt/apps/web/.env.local');
  });

  it('drops empties, absolutes, parent-escapes, and de-dupes', () => {
    const out = resolveProvisions('/repo', '/wt', [
      '',
      '   ',
      '/etc/passwd', // absolute → dropped
      '../secrets', // escape → dropped
      'a/../../b', // normalizes to ../b → escape → dropped
      'env/.env', // ok
      './env/.env' // duplicate of above → deduped
    ]);
    expect(out.map((p) => p.rel)).toEqual(['env/.env']);
  });

  it('returns [] for non-array / undefined', () => {
    expect(resolveProvisions('/r', '/w', undefined)).toEqual([]);
    expect(resolveProvisions('/r', '/w', null as never)).toEqual([]);
  });
});

describe('provisionFiles', () => {
  it('copies files (creating parent dirs) and reports copied vs missing', () => {
    const repo = mkdtempSync(join(tmpdir(), 'prov-repo-'));
    const wt = mkdtempSync(join(tmpdir(), 'prov-wt-'));
    mkdirSync(join(repo, 'apps/web'), { recursive: true });
    writeFileSync(join(repo, 'apps/web/.env.local'), 'SECRET=1\n');
    writeFileSync(join(repo, '.npmrc'), 'registry=x\n');

    const res = provisionFiles(repo, wt, ['apps/web/.env.local', '.npmrc', 'missing/file.txt']);

    expect(res.copied.sort()).toEqual(['.npmrc', 'apps/web/.env.local']);
    expect(res.missing).toEqual(['missing/file.txt']);
    // nested parent dir was created and content copied verbatim
    expect(existsSync(join(wt, 'apps/web/.env.local'))).toBe(true);
    expect(readFileSync(join(wt, 'apps/web/.env.local'), 'utf8')).toBe('SECRET=1\n');
  });

  it('overwrites an existing destination with the current main-checkout copy', () => {
    const repo = mkdtempSync(join(tmpdir(), 'prov-repo-'));
    const wt = mkdtempSync(join(tmpdir(), 'prov-wt-'));
    writeFileSync(join(repo, '.env'), 'NEW\n');
    writeFileSync(join(wt, '.env'), 'STALE\n');

    provisionFiles(repo, wt, ['.env']);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('NEW\n');
  });

  it('skips a directory entry (files only) rather than copying it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'prov-repo-'));
    const wt = mkdtempSync(join(tmpdir(), 'prov-wt-'));
    mkdirSync(join(repo, 'config'), { recursive: true });
    const res = provisionFiles(repo, wt, ['config']);
    expect(res.copied).toEqual([]);
    expect(res.missing).toEqual(['config']);
  });
});
