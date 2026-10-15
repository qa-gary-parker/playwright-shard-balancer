import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atomsFromTests } from '../src/atoms.js';
import { runCheck } from '../src/commands.js';
import { createEstimator } from '../src/estimate.js';
import { balance } from '../src/plan.js';
import { flattenReport, listing } from '../src/report.js';
import type { RunRecord } from '../src/run.js';
import { loadTimings } from '../src/timings.js';
import { type FixtureRun, membership, reporterPath, runBalanced, runFixture, runRaw } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'pwsb-reporter-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Durations by test title; the fixture sleeps for about these times.
const DURATIONS: Record<string, number> = {
  one: 300, two: 300, three: 300, beta: 50, 'delta alone': 10, first: 100, second: 100, third: 100,
  'zeta slow': 400, 'zeta anonymous': 30, authenticate: 10, 'lock a': 200, 'lock b': 200,
};
const durationOf = (title: string) => DURATIONS[title] ?? (title.startsWith('gamma') ? 20 : title.startsWith('epsilon') ? 60 : 1);

let list: unknown;
// override: a title's duration, or null to leave the test out of the timings.
const writeTimings = (name: string, override: (title: string) => number | null | undefined = () => undefined) => {
  const tests: Record<string, { samples: number[]; seen: string }> = {};
  for (const t of flattenReport(list)) {
    const title = t.titles.at(-1)!;
    const duration = override(title);
    if (duration !== null) tests[t.key] = { samples: [duration ?? durationOf(title)], seen: new Date().toISOString().slice(0, 10) };
  }
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ version: 1, tests }));
  return file;
};

let timings: string;
let full: string[];
beforeAll(() => {
  list = runFixture(['--list']).report;
  full = membership(list);
  timings = writeTimings('timings.json');
});

const shardsOf = (n: number, options: Record<string, unknown>, args: string[] = [], env: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, k) => runBalanced(['--list', `--shard=${k + 1}/${n}`, ...args], options, env));

describe('balancing reporter', () => {
  for (const n of [2, 3]) {
    it(`runs every test exactly once across ${n} shards, as the offline plan predicts`, () => {
      const grep = ['--grep-invert', 'lock'];
      const runs = shardsOf(n, { timings, granularity: 'file' }, grep);
      const shards = runs.map((r) => membership(r.report));
      expect(shards.flat().sort()).toEqual(membership(runFixture(['--list', ...grep]).report));
      expect(new Set(shards.flat()).size).toBe(shards.flat().length);

      const listed = listing(runFixture(['--list', ...grep]).report);
      const estimator = createEstimator(loadTimings(timings).timings);
      const plan = balance(atomsFromTests(listed.tests, estimator, 'file', listed.deps), n, 1);
      expect(shards).toEqual(plan.shards.map((s) => s.atoms.flatMap((a) => a.keys).sort()));
      for (const r of runs) expect(r.stderr).toMatch(new RegExp(`shard \\d/${n}: .* plan ${plan.sha}`));
    });
  }

  it('beats the built-in split on the fixture', () => {
    const estimator = createEstimator(loadTimings(timings).timings);
    const cost = (keys: string[]) => keys.reduce((acc, k) => acc + estimator.estimate({ key: k, project: 'chromium', file: '', staticSkip: k.endsWith('zeta skipped') }), 0);
    const balanced = Math.max(...shardsOf(2, { timings }).map((r) => cost(membership(r.report))));
    const builtin = Math.max(...[1, 2].map((k) => cost(membership(runFixture(['--list', `--shard=${k}/2`]).report))));
    expect(balanced).toBeLessThan(builtin);
  });

  it('keeps a serial describe on one shard while splitting parallel tests', () => {
    const heavy = writeTimings('heavy-serial.json', (title) => (['first', 'second', 'third'].includes(title) ? 1000 : undefined));
    for (const n of [2, 3, 4]) {
      const shards = shardsOf(n, { timings: heavy }, [], { FULLY_PARALLEL: '1' }).map((r) => membership(r.report));
      const withSerial = shards.filter((s) => s.some((k) => k.includes('delta serial')));
      expect(withSerial).toHaveLength(1);
      expect(withSerial[0].filter((k) => k.includes('delta serial'))).toHaveLength(3);
    }
  });

  it('splits a file across shards only when its tests may run apart', () => {
    // Alpha (900ms) is over a third of the work; at 3 shards splitting it is the only way to balance.
    const spread = (env: Record<string, string>) =>
      shardsOf(3, { timings }, [], env).filter((r) => membership(r.report).some((k) => k.includes('alpha.test.ts'))).length;
    expect(spread({ FULLY_PARALLEL: '1' })).toBeGreaterThan(1);
    expect(spread({})).toBe(1);
  });

  it('keeps default-mode, nested serial and anonymous serial describes whole in a parallel file', () => {
    const heavy = writeTimings('heavy-groups.json', (title) => (/^(d\d|o1|i1|gm anonymous)/.test(title) ? 1000 : undefined));
    for (const n of [2, 3, 4]) {
      const shards = shardsOf(n, { timings: heavy }).map((r) => membership(r.report));
      const where = (pattern: RegExp) => shards.flatMap((s, k) => (s.some((key) => pattern.test(key)) ? [k] : []));
      for (const group of [/gm default/, /gm outer/, /gm anonymous x/, /gm anonymous y/]) expect(where(group)).toHaveLength(1);
      // The two anonymous serial describes are separate groups, so balancing puts them apart.
      if (n === 4) expect(new Set([...where(/gm anonymous x/), ...where(/gm anonymous y/)]).size).toBe(2);
    }
  });

  it('plans tests that have no timings yet as the offline plan does', () => {
    const grep = ['--grep-invert', 'lock|gm '];
    const partial = writeTimings('partial.json', (title) => (['three', 'gamma 3', 'zeta slow'].includes(title) ? null : undefined));
    const listed = listing(runFixture(['--list', ...grep]).report);
    const plan = balance(atomsFromTests(listed.tests, createEstimator(loadTimings(partial).timings), 'file', listed.deps), 3, 1);
    expect(plan.unknown_tests).toBe(3);
    const shards = shardsOf(3, { timings: partial, granularity: 'file' }, grep).map((r) => membership(r.report));
    expect(shards).toEqual(plan.shards.map((s) => s.atoms.flatMap((a) => a.keys).sort()));
  });

  it('keeps tests that share a lock on one shard', () => {
    for (const n of [2, 3, 4]) {
      const shards = shardsOf(n, { timings }).map((r) => membership(r.report));
      const withLock = shards.filter((s) => s.some((k) => k.includes('lock-')));
      expect(withLock).toHaveLength(1);
      expect(withLock[0].filter((k) => k.includes('lock-'))).toHaveLength(2);
    }
  });

  it('runs the setup project on every shard', () => {
    for (const r of shardsOf(3, { timings })) {
      expect(flattenReport(r.report).filter((t) => t.project === 'setup').map((t) => t.key)).toEqual(['[setup] › auth.setup.ts › authenticate']);
    }
  });

  it('splits --repeat-each copies and still runs each exactly once', () => {
    // A JSON report does not show which repeat a test is, so count through run records.
    const records = [1, 2].map((k) => {
      const file = join(dir, `repeat-${k}.json`);
      runBalanced([`--shard=${k}/2`, '--repeat-each=2'], { timings, record: file }, { FIXTURE_SCALE: '0' });
      return file;
    });
    const result = runCheck({ records });
    expect(result.duplicates).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.tests).toBe(full.length * 2);
  });

  it.each([
    ['there is no timings file', () => join(dir, 'missing.json'), /no timings file at/],
    ['the timings file is corrupt', () => (writeFileSync(join(dir, 'corrupt.json'), '{'), join(dir, 'corrupt.json')), /cannot read timings: .* is not valid JSON/],
    ['the timings file is empty', () => (writeFileSync(join(dir, 'empty.json'), '{"version":1,"tests":{}}'), join(dir, 'empty.json')), /has no entries/],
  ])("falls back to Playwright's built-in split when %s", (_, file, message) => {
    for (const k of [1, 2]) {
      const run = runBalanced(['--list', `--shard=${k}/2`], { timings: file() });
      expect(membership(run.report)).toEqual(membership(runFixture(['--list', `--shard=${k}/2`]).report));
      expect(run.stderr).toMatch(message);
      expect(run.stderr).toContain("using Playwright's built-in sharding");
    }
  });

  it('plans the same on every shard when machines resolve a different worker count', () => {
    const runs = [1, 2].map((k) => runBalanced(['--list', `--shard=${k}/2`], { timings }, { FULLY_PARALLEL: '1', WORKERS: k === 1 ? '1' : '3' }));
    const plans = runs.map((r) => /plan (\w+)/.exec(r.stderr)?.[1]);
    expect(plans[0]).toMatch(/^\w{12}$/);
    expect(plans[1]).toBe(plans[0]);
    const shards = runs.map((r) => membership(r.report));
    expect(shards.flat().sort()).toEqual(membership(runFixture(['--list'], { FULLY_PARALLEL: '1' }).report));
  });

  it('packs for the workers option, and says so', () => {
    // The JSON list cannot show default-mode describes or locks, so leave them out of the offline plan.
    const grep = ['--grep-invert', 'gm |lock'];
    const listed = listing(runFixture(['--list', ...grep], { FULLY_PARALLEL: '1' }).report);
    const offline = (workers: number) =>
      balance(atomsFromTests(listed.tests, createEstimator(loadTimings(timings).timings), 'test', listed.deps), 2, workers).shards[0].atoms.flatMap((a) => a.keys).sort();
    expect(offline(4)).not.toEqual(offline(1));
    const shardOne = (options: Record<string, unknown>): FixtureRun => runBalanced(['--list', '--shard=1/2', ...grep], { timings, ...options }, { FULLY_PARALLEL: '1' });
    const one = shardOne({});
    const four = shardOne({ workers: 4 });
    expect(membership(one.report)).toEqual(offline(1));
    expect(membership(four.report)).toEqual(offline(4));
    expect(one.stderr).toContain(', 1 worker(s), plan ');
    expect(four.stderr).toContain(', 4 worker(s), plan ');
  });

  it.each([
    ['the option', { strict: true }, {}, () => 'missing.json', /no timings file at/],
    ['the env var', {}, { PLAYWRIGHT_SHARD_BALANCER_STRICT: '1' }, () => 'missing.json', /no timings file at/],
    ['the env var, over strict: false', { strict: false }, { PLAYWRIGHT_SHARD_BALANCER_STRICT: '1' }, () => 'missing.json', /no timings file at/],
    ['the option, for a corrupt file', { strict: true }, {}, () => (writeFileSync(join(dir, 'strict-corrupt.json'), '{'), 'strict-corrupt.json'), /cannot read timings: .* is not valid JSON/],
    ['the option, for an empty file', { strict: true }, {}, () => (writeFileSync(join(dir, 'strict-empty.json'), '{"version":1,"tests":{}}'), 'strict-empty.json'), /has no entries/],
  ])('in strict mode from %s, fails the run instead of falling back', (_, options, env, file, reason) => {
    const run = runBalanced(['--list', '--shard=1/2'], { timings: join(dir, file()), ...options }, env);
    expect(run.status).toBe(1);
    expect(run.report.errors.map((e: { message: string }) => e.message).join('\n')).toMatch(new RegExp(`shard 1/2: (timings file .* )?${reason.source}.*strict mode stops the run`));
    expect(membership(run.report)).toEqual([]);
  });

  it('in strict mode, passes a shard run that has no tests to split', () => {
    const run = runBalanced(['--list', '--shard=1/2', '--grep', 'no such test', '--pass-with-no-tests'], { timings, strict: true });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('playwright-shard-balancer: shard 1/2: no tests to balance');
  });

  it.each([
    [{ granularity: 'test' }, /granularity must be "auto" or "file", got "test"/],
    [{ workers: 0 }, /workers must be a positive integer, got 0/],
  ])('rejects bad options %j', (options, message) => {
    const run = runRaw(['--list', '--shard=1/2'], { PWSB_REPORTER: reporterPath, PWSB_OPTIONS: JSON.stringify({ timings, ...options }) });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(message);
  });

  it('does nothing without --shard', () => {
    const run = runBalanced(['--list'], { timings });
    expect(membership(run.report)).toEqual(full);
    expect(run.stderr).not.toContain('playwright-shard-balancer');
  });
});

describe('run records and check', () => {
  const record = (name: string) => join(dir, name);
  const readRecord = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as RunRecord;

  it('records each shard so check can prove every test ran once', () => {
    for (const k of [1, 2]) {
      const run = runBalanced([`--shard=${k}/2`], { timings, record: join(dir, 'ok-{shard}.json') });
      expect(run.status).toBe(0);
    }
    const one = readRecord(record('ok-1.json'));
    expect(one).toMatchObject({ strategy: 'balanced', shard: { current: 1, total: 2 }, status: 'passed' });
    expect(one.tests.find((t) => t.key === '[setup] › auth.setup.ts › authenticate')).toMatchObject({ setup: true, outcome: 'expected', ran: true });
    expect(one.predicted_ms).toHaveLength(2);

    const result = runCheck({ records: [record('ok-1.json'), record('ok-2.json')] });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.tests).toBe(full.length);
    expect(result.duplicates).toEqual([]);
  });

  it('fails when the shards read different timings', () => {
    const skewed = writeTimings('skewed.json', (title) => (title.startsWith('gamma') ? 5000 : undefined));
    runBalanced(['--shard=1/2'], { timings, record: join(dir, 'mixed-{shard}.json') });
    runBalanced(['--shard=2/2'], { timings: skewed, record: join(dir, 'mixed-{shard}.json') });
    const result = runCheck({ records: [record('mixed-1.json'), record('mixed-2.json')] });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/shards used different timings/);
    expect(result.problems).toContainEqual(expect.stringMatching(/^\d+ test\(s\) ran in more than one shard: /));
  });

  it('fails when one shard fell back to the built-in split', () => {
    runBalanced(['--shard=1/2'], { timings, record: join(dir, 'fallback-{shard}.json') });
    runBalanced(['--shard=2/2'], { timings: join(dir, 'missing.json'), record: join(dir, 'fallback-{shard}.json') });
    const result = runCheck({ records: [record('fallback-1.json'), record('fallback-2.json')] });
    expect(result.ok).toBe(false);
    expect(result.strategy).toBe('mixed');
    expect(result.problems[0]).toMatch(/shards split the suite differently: 1=balanced, 2=builtin \(no timings file at/);
  });

  it('records predicted wall times that match the offline plan, setup included', () => {
    const grep = ['--grep-invert', 'lock|gm '];
    const listed = listing(runFixture(['--list', ...grep]).report);
    const plan = balance(atomsFromTests(listed.tests, createEstimator(loadTimings(timings).timings), 'file', listed.deps), 2, 1, new Map([['setup', durationOf('authenticate')]]));
    runBalanced(['--shard=1/2', ...grep], { timings, granularity: 'file', record: record('predicted-{shard}.json') }, { FIXTURE_SCALE: '0' });
    expect(readRecord(record('predicted-1.json')).predicted_ms).toEqual(plan.shards.map((s) => s.wall_ms));
  });

  it('puts --repeat-each copies on different shards, and check --list names a missing copy', () => {
    const files = [1, 2].map((k) => {
      const file = record(`alpha-repeat-${k}.json`);
      runBalanced([`--shard=${k}/2`, '--repeat-each=2', '--grep', 'alpha'], { timings, record: file }, { FIXTURE_SCALE: '0' });
      return file;
    });
    const records = files.map(readRecord);
    expect(records.map((r) => r.strategy)).toEqual(['balanced', 'balanced']);
    const target = '[chromium] › alpha.test.ts › alpha › one';
    const repeats = records.map((r) => r.tests.filter((t) => t.key === target).map((t) => t.repeat));
    expect(repeats.map((r) => r.length)).toEqual([1, 1]);
    expect(repeats.flat().sort()).toEqual([0, 1]);

    const listFile = record('alpha-repeat-list.json');
    writeFileSync(listFile, JSON.stringify(runFixture(['--list', '--repeat-each=2', '--grep', 'alpha']).report));
    for (const [k, r] of records.entries()) writeFileSync(files[k], JSON.stringify({ ...r, tests: r.tests.filter((t) => !(t.key === target && t.repeat === 1)) }));
    expect(runCheck({ records: files, list: listFile }).missing).toEqual([`${target} (repeat 1)`]);
  });

  it('writes no run record for a --list run', () => {
    runBalanced(['--list', '--shard=1/2'], { timings, record: record('list-only-{shard}.json') });
    expect(existsSync(record('list-only-1.json'))).toBe(false);
  });

  it('fails when a shard record is missing', () => {
    const result = runCheck({ records: [record('ok-1.json')] });
    expect(result.problems).toContain('missing records for shard 2');
  });
});
