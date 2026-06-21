import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  countAssertions,
  weakeningSignal,
  suitesDiffer,
  readSuiteDir,
  writeSuiteDir,
  acceptanceDir,
  sanitizeSuitePath
} from '../src/acceptance.js';

describe('sanitizeSuitePath', () => {
  it('fixes JS-style .test.py names that break pytest collection', () => {
    // the flask-4045 gate bug: test_foo.test.py → module test_foo.test → ModuleNotFoundError
    expect(sanitizeSuitePath('acceptance/test_blueprint.test.py')).toBe('acceptance/test_blueprint.py');
    expect(sanitizeSuitePath('acceptance/foo.spec.py')).toBe('acceptance/test_foo.py');
  });

  it('replaces other embedded stem dots and ensures a test_ prefix', () => {
    expect(sanitizeSuitePath('acceptance/api.v1.checks.py')).toBe('acceptance/test_api_v1_checks.py');
    expect(sanitizeSuitePath('acceptance/checks.py')).toBe('acceptance/test_checks.py');
  });

  it('leaves already-valid pytest names and JS/TS files untouched', () => {
    expect(sanitizeSuitePath('acceptance/test_thing.py')).toBe('acceptance/test_thing.py');
    expect(sanitizeSuitePath('acceptance/thing_test.py')).toBe('acceptance/thing_test.py');
    expect(sanitizeSuitePath('acceptance/thing.test.ts')).toBe('acceptance/thing.test.ts');
    expect(sanitizeSuitePath('acceptance/Thing.spec.tsx')).toBe('acceptance/Thing.spec.tsx');
  });
});

describe('acceptanceDir', () => {
  it('defaults and normalizes', () => {
    expect(acceptanceDir()).toBe('acceptance');
    expect(acceptanceDir('./tests/acc/')).toBe('tests/acc');
  });
});

describe('countAssertions', () => {
  it('counts expect/it/test markers', () => {
    const src = `it('x', () => { expect(a).toBe(1); expect(b).toEqual(2); }); test('y', () => expect(c).toBeTruthy());`;
    expect(countAssertions(src)).toBe(5); // it + test + 3 expects
  });
});

describe('weakeningSignal', () => {
  const canonical = [
    { path: 'acceptance/a.test.ts', content: `it('full', () => { expect(f(1)).toEqual(10); expect(f(2)).toEqual(20); });` }
  ];

  it('flags removed assertions', () => {
    const modified = [{ path: 'acceptance/a.test.ts', content: `it('full', () => { expect(f(1)).toEqual(10); });` }];
    expect(weakeningSignal(canonical, modified).removedAssertions).toBe(true);
  });

  it('flags loosened matchers', () => {
    const modified = [
      { path: 'acceptance/a.test.ts', content: `it('full', () => { expect(f(1)).toBeTruthy(); expect(f(2)).toBeDefined(); });` }
    ];
    expect(weakeningSignal(canonical, modified).loosenedMatchers).toBe(true);
  });

  it('does not flag an unchanged or strengthened suite', () => {
    const stronger = [
      {
        path: 'acceptance/a.test.ts',
        content: `it('full', () => { expect(f(1)).toEqual(10); expect(f(2)).toEqual(20); expect(f(3)).toEqual(30); });`
      }
    ];
    const sig = weakeningSignal(canonical, stronger);
    expect(sig.removedAssertions).toBe(false);
    expect(sig.loosenedMatchers).toBe(false);
  });
});

describe('suitesDiffer', () => {
  const a = [{ path: 'acceptance/a.test.ts', content: 'x' }];
  it('is false for identical suites and true when content changes', () => {
    expect(suitesDiffer(a, [{ path: 'acceptance/a.test.ts', content: 'x' }])).toBe(false);
    expect(suitesDiffer(a, [{ path: 'acceptance/a.test.ts', content: 'y' }])).toBe(true);
  });
});

describe('readSuiteDir / writeSuiteDir round-trip', () => {
  it('writes then reads back the same files', () => {
    const root = mkdtempSync(join(tmpdir(), 'acc-'));
    const files = [
      { path: 'acceptance/one.test.ts', content: 'aaa' },
      { path: 'acceptance/sub/two.test.ts', content: 'bbb' }
    ];
    writeSuiteDir(root, 'acceptance', files);
    expect(existsSync(join(root, 'acceptance/one.test.ts'))).toBe(true);
    expect(readFileSync(join(root, 'acceptance/sub/two.test.ts'), 'utf8')).toBe('bbb');
    const back = readSuiteDir(root, 'acceptance');
    expect(back).toEqual(files);
  });
});
