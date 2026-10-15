import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dependencyProjects, flattenReport, listedTests, reportErrors } from '../src/report.js';
import { membership, runFixture } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'pwsb-report-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const list = runFixture(['--list']).report;

describe('flattenReport', () => {
  it('keys each test like a --test-list line, leaving anonymous describes out', () => {
    const keys = flattenReport(list).map((t) => t.key);
    expect(keys).toContain('[chromium] › alpha.test.ts › alpha › one');
    expect(keys).toContain('[chromium] › zeta.test.ts › zeta anonymous');
    expect(keys).toContain('[setup] › auth.setup.ts › authenticate');
  });

  it('lists tests in the order Playwright loads them: by project, then file, then line', () => {
    const delta = flattenReport(list)
      .filter((t) => t.file === 'delta.test.ts')
      .map((t) => t.titles.join(' › '));
    expect(delta).toEqual(['delta serial › first', 'delta serial › second', 'delta serial › third', 'delta alone']);
    expect(flattenReport(list)[0].project).toBe('setup');
  });

  it('marks tests skipped before they run', () => {
    const skipped = flattenReport(list).filter((t) => t.staticSkip).map((t) => t.key);
    expect(skipped).toEqual(['[chromium] › zeta.test.ts › zeta skipped']);
  });

  it('selects exactly the keyed tests when the keys are passed to --test-list', () => {
    const chosen = ['[chromium] › alpha.test.ts › alpha › two', '[chromium] › delta.test.ts › delta alone', '[chromium] › zeta.test.ts › zeta anonymous'];
    const file = join(dir, 'list.txt');
    writeFileSync(file, `${chosen.join('\n')}\n`);
    expect(membership(runFixture(['--list', '--test-list', file]).report)).toEqual([...chosen].sort());
  });

  it('rejects data that is not a JSON report', () => {
    expect(() => flattenReport({ tests: [] })).toThrow('not a Playwright JSON report');
  });
});

describe('listedTests', () => {
  it('leaves out projects that only run as dependencies', () => {
    const projects = new Set(listedTests(list).map((t) => t.project));
    expect([...projects]).toEqual(['chromium']);
  });
});

describe('dependencyProjects', () => {
  const projects = [
    { name: 'setup', dependencies: [], teardown: 'cleanup' },
    { name: 'cleanup', dependencies: [] },
    { name: 'db', dependencies: [] },
    { name: 'e2e', dependencies: ['setup', 'db'] },
    { name: 'other', dependencies: [] },
  ];

  it('follows dependencies and teardowns transitively from the projects that have tests', () => {
    expect([...dependencyProjects(projects, ['e2e', 'other'])].sort()).toEqual(['cleanup', 'db', 'setup']);
  });

  it('treats a project as a dependency even when it also has its own tests, as Playwright does', () => {
    expect(dependencyProjects(projects, ['setup', 'e2e']).has('setup')).toBe(true);
  });
});

describe('reportErrors', () => {
  it('returns the first line of each run-level error without colour codes', () => {
    expect(reportErrors({ suites: [], errors: [{ message: '\u001b[31mSyntaxError: x\u001b[39m\n  at a.ts:1' }] })).toEqual(['SyntaxError: x']);
  });
});
