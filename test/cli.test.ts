import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliPath, membership, runBalanced, runFixture } from './helpers.js';

let dir: string;
const path = (name: string) => join(dir, name);
const write = (name: string, data: unknown) => writeFileSync(path(name), typeof data === 'string' ? data : JSON.stringify(data));

function cli(args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: () => JSON.parse(result.stdout) };
}

// Plans cannot express helper-defined tests as --test-list lines, so plan lists leave them out.
const NO_HELPERS = ['--grep-invert', 'shared suite'];

// Shared by every test below, so each test can also run alone.
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwsb-cli-'));
  write('list.json', runFixture(['--list']).report);
  write('list-plan.json', runFixture(['--list', ...NO_HELPERS]).report);
  write('list-plan-parallel.json', runFixture(['--list', ...NO_HELPERS], { FULLY_PARALLEL: '1' }).report);
  write('list-parallel.json', runFixture(['--list'], { FULLY_PARALLEL: '1' }).report);
  write('report.json', runFixture([]).report);
  cli(['update', '--timings', 'base-timings.json', 'report.json']);
  for (const k of [1, 2]) runBalanced([`--shard=${k}/2`], { timings: path('base-timings.json'), record: path('ok-{shard}.json') });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('update', () => {
  it('learns a sample from each passing test of a report, and skips an input it has already merged', () => {
    const first = cli(['update', '--timings', 'fresh.json', 'report.json']);
    expect(first.status).toBe(0);
    const tests = membership(JSON.parse(readFileSync(path('report.json'), 'utf8'))).length;
    // The fixture's one statically skipped test gives no sample; the setup test does.
    expect(first.json()).toMatchObject({ inputs: 1, skipped_inputs: 0, samples: tests, new_tests: tests, tests });
    const timings = JSON.parse(readFileSync(path('fresh.json'), 'utf8'));
    expect(timings.tests['[chromium] › alpha.test.ts › alpha › one'].samples[0]).toBeGreaterThanOrEqual(300);
    expect(timings.tests['[chromium] › zeta.test.ts › zeta skipped']).toBeUndefined();

    const again = cli(['update', '--timings', 'fresh.json', 'report.json']);
    expect(again.json()).toMatchObject({ skipped_inputs: 1, samples: 0 });
    expect(again.stderr).toContain('report.json: already merged, skipped');
    expect(JSON.parse(readFileSync(path('fresh.json'), 'utf8')).tests['[chromium] › alpha.test.ts › alpha › one'].samples).toHaveLength(1);
  });

  it('keeps tests that a shared helper defines in two specs apart', () => {
    const timings = JSON.parse(readFileSync(path('fresh.json'), 'utf8'));
    expect(timings.tests['[chromium] › helper-a.test.ts › shared suite › works']).toBeDefined();
    expect(timings.tests['[chromium] › helper-b.test.ts › shared suite › works']).toBeDefined();
  });

  it('learns from the run records of all shards, one setup sample per run', () => {
    const result = cli(['update', '--timings', 'from-records.json', 'ok-1.json', 'ok-2.json']);
    expect(result.status).toBe(0);
    const tests = membership(JSON.parse(readFileSync(path('report.json'), 'utf8'))).length;
    // Every passing test once, plus the setup test that both shards ran, once.
    expect(result.json().samples).toBe(tests);
    const timings = JSON.parse(readFileSync(path('from-records.json'), 'utf8'));
    expect(timings.tests['[setup] › auth.setup.ts › authenticate'].samples).toHaveLength(1);
  });

  it('rejects an input that is neither a report nor a record', () => {
    write('other.json', { hello: 1 });
    const result = cli(['update', '--timings', 'timings.json', 'other.json']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('other.json is neither a Playwright JSON report nor a run record');
  });
});

describe('simulate', () => {
  it('compares the built-in and balanced splits for a range of shard counts', () => {
    const result = cli(['simulate', '--timings', 'base-timings.json', '--list', 'list.json', '--shards', '2-4']);
    expect(result.status).toBe(0);
    const rows = result.json().rows as { shards: number; builtin_ms: number; balanced_ms: number; lower_bound_ms: number }[];
    expect(rows.map((r) => r.shards)).toEqual([2, 3, 4]);
    for (const r of rows) {
      expect(r.balanced_ms).toBeLessThanOrEqual(r.builtin_ms);
      expect(r.balanced_ms).toBeGreaterThanOrEqual(r.lower_bound_ms);
    }
    expect(result.stderr).toMatch(/2 shards: built-in .*, balanced .* \(\d+% faster\), best possible/);
  });

  it('recommends the fewest shards that meet a target, counting per-shard overhead', () => {
    const at = (target: string, overhead: string) =>
      cli(['simulate', '--timings', 'base-timings.json', '--list', 'list.json', '--shards', '1-8', '--target', target, '--overhead', overhead]).json();
    // The fixture holds about 2.6s of tests, and its largest file takes about 0.9s.
    expect(at('1h', '0s').recommended_shards).toBe(1);
    const plain = at('2s', '0s');
    expect(plain.recommended_shards).toBe(2);
    expect(plain.rows[0].elapsed_ms).toBeGreaterThan(2000);
    expect(plain.rows[1].elapsed_ms).toBeLessThanOrEqual(2000);
    expect(at('2s', '1s').recommended_shards).toBeGreaterThan(2);
    expect(at('1s', '1s').recommended_shards).toBeNull();
  });

  it('splits by test for a fullyParallel suite unless told otherwise, as the reporter would', () => {
    const run = (extra: string[]) => cli(['simulate', '--timings', 'base-timings.json', '--list', 'list-parallel.json', '--shards', '4', ...extra]).json();
    expect(run([])).toMatchObject({ granularity: 'test', builtin_granularity: 'test' });
    expect(run(['--granularity', 'file']).granularity).toBe('file');
    for (const r of run([]).rows) expect(r.balanced_ms).toBeLessThanOrEqual(r.builtin_ms);
  });

  it('shows per-shard detail for one shard count, setup included', () => {
    const detail = cli(['simulate', '--timings', 'base-timings.json', '--list', 'list.json', '--shards', '3']).json();
    expect(detail.detail.balanced.shards).toHaveLength(3);
    expect(detail.setup_ms.setup).toBeGreaterThan(0);
    for (const s of detail.detail.balanced.shards) expect(s.setup_ms).toBe(detail.setup_ms.setup);
  });
});

describe('plan', () => {
  for (const granularity of ['file', 'test']) {
    it(`writes --test-list files that run every test once (${granularity} granularity)`, () => {
      const out = `plan-${granularity}`;
      const list = granularity === 'test' ? 'list-plan-parallel.json' : 'list-plan.json';
      const env: Record<string, string> = granularity === 'test' ? { FULLY_PARALLEL: '1' } : {};
      const result = cli(['plan', '--timings', 'base-timings.json', '--list', list, '--shards', '3', '--out-dir', out, '--granularity', granularity]);
      expect(result.status).toBe(0);
      const plan = JSON.parse(readFileSync(path(`${out}/plan.json`), 'utf8'));
      expect(plan.shards).toHaveLength(3);
      const shards = [1, 2, 3].map((k) => runFixture(['--list', ...NO_HELPERS, '--test-list', path(`${out}/shard-${k}.txt`)], env).report);
      const keys = shards.flatMap((r) => membership(r));
      expect(keys.sort()).toEqual(membership(JSON.parse(readFileSync(path(list), 'utf8'))));
      expect(new Set(keys).size).toBe(keys.length);
      // Setup still runs on each shard, and a serial describe stays on one.
      for (const r of shards) expect(JSON.stringify(r)).toContain('auth.setup.ts');
      expect(shards.filter((r) => membership(r).some((k) => k.includes('delta serial')))).toHaveLength(1);
    });
  }

  it('refuses a list with --repeat-each copies', () => {
    write('list-repeat.json', runFixture(['--list', '--repeat-each=2', ...NO_HELPERS]).report);
    const result = cli(['plan', '--timings', 'base-timings.json', '--list', 'list-repeat.json', '--shards', '2', '--out-dir', 'nope']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/is listed twice \(--repeat-each\?\)/);
    expect(existsSync(path('nope'))).toBe(false);
  });

  it('refuses tests defined in a shared helper, whose --test-list line would select them in every spec', () => {
    const result = cli(['plan', '--timings', 'base-timings.json', '--list', 'list.json', '--shards', '2', '--out-dir', 'nope']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/"\[chromium\] › helper-a\.test\.ts › shared suite › works" is defined in shared\.ts/);
  });

  it('refuses a test whose title path starts another test', () => {
    const list = JSON.parse(readFileSync(path('list-plan.json'), 'utf8'));
    const spec = (title: string) => ({ title, file: 'x.test.ts', line: 1, column: 1, tests: [{ projectName: 'chromium', status: 'expected', results: [] }] });
    list.suites.push({ title: 'x.test.ts', file: 'x.test.ts', specs: [spec('x')], suites: [{ title: 'x', file: 'x.test.ts', specs: [spec('t')] }] });
    write('list-prefix.json', list);
    const result = cli(['plan', '--timings', 'base-timings.json', '--list', 'list-prefix.json', '--shards', '2', '--out-dir', 'nope']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"[chromium] › x.test.ts › x" is a test and also starts the title of "[chromium] › x.test.ts › x › t"');
  });

  it('refuses test granularity for a list from before Playwright 1.63, which cannot mark serial describes', () => {
    const list = JSON.parse(readFileSync(path('list-plan-parallel.json'), 'utf8'));
    list.config.version = '1.62.0';
    write('list-old.json', list);
    const result = cli(['plan', '--timings', 'base-timings.json', '--list', 'list-old.json', '--shards', '2', '--out-dir', 'nope', '--granularity', 'test']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--granularity test needs a list from Playwright 1.63+');
  });
});

describe('check', () => {
  it('exits 0 and appends a markdown summary for a complete run', () => {
    write('summary.md', '# CI\n');
    const result = cli(['check', 'ok-1.json', 'ok-2.json', '--list', 'list.json', '--summary', 'summary.md']);
    expect(result.status).toBe(0);
    expect(result.json()).toMatchObject({ ok: true, missing: [], duplicates: [], strategy: 'balanced' });
    const md = readFileSync(path('summary.md'), 'utf8');
    expect(md).toMatch(/^# CI\n### Shard balance: ok/);
    expect(md).toMatch(/\| 1 \| \d+ \| [\d.]+s \| [\d.]+s \| [\d.]+s \| passed \|/);
  });

  it('exits 1 and names the tests no shard ran', () => {
    const record = JSON.parse(readFileSync(path('ok-2.json'), 'utf8'));
    const dropped = record.tests.find((t: { setup?: boolean }) => !t.setup).key;
    record.tests = record.tests.filter((t: { key: string }) => t.key !== dropped);
    write('partial-2.json', record);
    const result = cli(['check', 'ok-1.json', 'partial-2.json', '--list', 'list.json']);
    expect(result.status).toBe(1);
    expect(result.json().missing).toEqual([dropped]);
  });

  it('exits 1 when tests did not run, here after max failures', () => {
    // Unsharded and on one worker, so the tests after beta are always the ones left.
    runBalanced(['--max-failures=1'], { timings: path('base-timings.json'), record: path('stopped-{shard}.json') }, { FAIL_BETA: '1' });
    const result = cli(['check', 'stopped-all.json']);
    expect(result.status).toBe(1);
    expect(result.json().not_run.length).toBeGreaterThan(0);
    expect(result.stderr).toMatch(/\d+ test\(s\) did not run: the run was interrupted, stopped at max failures, or a setup project failed/);
  });

  it('exits 1 without --list when the shards ran fewer tests than they saw', () => {
    const result = cli(['check', 'ok-1.json', 'partial-2.json']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/the shards ran \d+ distinct tests, but each saw \d+ before the split/);
  });

  it('exits 1 for a file that is not a run record', () => {
    const result = cli(['check', 'report.json']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not a run record');
  });
});

describe('usage', () => {
  it.each([
    [['frobnicate'], /unknown command "frobnicate"/],
    [[], /missing command/],
    [['update', 'report.json'], /missing --timings/],
    [['update', '--timings', 't.json'], /pass at least one JSON report or run record/],
    [['simulate', '--timings', 't.json', '--list', 'l.json'], /missing --shards/],
    [['simulate', '--timings', 't.json', '--list', 'l.json', '--shards', '4-2'], /--shards must be a number or a range like 2-8, got "4-2"/],
    [['simulate', '--timings', 't.json', '--list', 'l.json', '--shards', '2', '--target', '10 minutes'], /durations look like 90s, 12m or 1h30m/],
    [['simulate', '--timings', 't.json', '--list', 'l.json', '--shards', '2', '--workers', '0'], /--workers must be a positive integer/],
    [['simulate', '--timings', 't.json', '--list', 'l.json', '--shards', '2', '--granularity', 'describe'], /--granularity must be "file" or "test"/],
    [['plan', '--timings', 't.json', '--list', 'l.json', '--shards', '2'], /missing --out-dir/],
    [['check'], /pass the run record of every shard/],
    [['simulate', '--bogus'], /Unknown option '--bogus'/],
  ])('exits 2 with usage for %j', (args, message) => {
    const result = cli(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain('Usage:');
  });
});
