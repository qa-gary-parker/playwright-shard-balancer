import { describe, expect, it } from 'vitest';
import type { ReportTest } from '../src/report.js';
import { check, RUN_KIND, type RunRecord, type RunTest, samplesFromReport, samplesFromRun } from '../src/run.js';

const test = (key: string, extra: Partial<RunTest> = {}): RunTest => ({ key, repeat: 0, outcome: 'expected', static_skip: false, duration_ms: 1, ran: true, ...extra });
const record = (current: number | null, tests: RunTest[], extra: Partial<RunRecord> = {}): RunRecord => ({
  kind: RUN_KIND, version: 1, shard: current === null ? null : { current, total: 2 }, strategy: current === null ? 'none' : 'balanced', reason: null,
  timings_sha: 't', plan_sha: 'p', corpus: null, predicted_ms: [1, 1], granularity: 'auto', workers: 1, playwright: '1.64.1',
  wall_ms: 1, tests_ms: 1, status: 'passed', tests, ...extra,
});

describe('check', () => {
  it('passes a run where every listed test ran once', () => {
    const result = check([record(1, [test('a'), test('b')]), record(2, [test('c')])], ['a', 'b', 'c']);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('names a test that ran on two shards', () => {
    const result = check([record(1, [test('a'), test('b')]), record(2, [test('b'), test('c')])], ['a', 'b', 'c']);
    expect(result.duplicates).toEqual(['b']);
    expect(result.problems).toEqual(['1 test(s) ran in more than one shard: b']);
  });

  it('names listed tests that no shard ran, the first ten in full', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    const result = check([record(1, [test('a')]), record(2, [])], ['a', ...keys]);
    expect(result.problems).toEqual([`12 listed test(s) ran in no shard: ${keys.slice(0, 10).join(', ')} and 2 more`]);
  });

  it('names tests that did not run', () => {
    const result = check([record(1, [test('a'), test('b', { ran: false })]), record(2, [test('c')])]);
    expect(result.problems).toEqual(['1 test(s) did not run (interrupted, stopped at max failures, or a setup project failed): b']);
  });

  it('fails shards that used different plans from the same timings', () => {
    const result = check([record(1, [test('a')]), record(2, [test('b')], { plan_sha: 'q' })], ['a', 'b']);
    expect(result.problems).toEqual(['shards used different plan: p, q']);
  });

  it('fails shards that saw different tests before the split', () => {
    const result = check([record(1, [test('a')], { corpus: { tests: 2, sha: 's1' } }), record(2, [test('b')], { corpus: { tests: 3, sha: 's2' } })], ['a', 'b']);
    expect(result.problems).toEqual(['shards saw different test sets before the split: 2:s1, 3:s2']);
  });

  it('fails two records for one shard', () => {
    const result = check([record(1, [test('a')]), record(1, [test('b')]), record(2, [test('c')])], ['a', 'b', 'c']);
    expect(result.problems).toEqual(['more than one record for shard 1']);
  });

  it('fails records that disagree on the shard total', () => {
    const result = check([record(1, [test('a')]), record(2, [test('b')], { shard: { current: 2, total: 3 } })], ['a', 'b']);
    expect(result.problems).toEqual(['records disagree on the shard total: 2, 3', 'missing records for shard 3']);
  });

  it('checks runs of plan test lists, which have no shard numbers, against the list', () => {
    const records = [record(null, [test('a')]), record(null, [test('b')])];
    expect(check(records, ['a', 'b']).problems).toEqual([]);
    expect(check(records, ['a', 'b', 'c']).problems).toEqual(['1 listed test(s) ran in no shard: c']);
    expect(check(records).problems).toEqual(['the records have no shard numbers (runs of `plan` test lists?); pass --list to check them']);
  });
});

describe('samples', () => {
  it('learns only from tests that ran and passed, retries included', () => {
    const tests = [
      test('good'),
      test('flaky', { outcome: 'flaky', duration_ms: 7 }),
      test('failed', { outcome: 'unexpected', duration_ms: 30_000 }),
      test('cut', { ran: false }),
      test('skipped', { outcome: 'skipped', static_skip: true, duration_ms: 0 }),
      test('login', { setup: true, duration_ms: 3 }),
    ];
    expect(samplesFromRun(record(1, tests))).toEqual([
      { key: 'good', durationMs: 1, setup: false },
      { key: 'flaky', durationMs: 7, setup: false },
      { key: 'login', durationMs: 3, setup: true },
    ]);
  });

  it('learns the same way from a JSON report', () => {
    const report = (key: string, extra: Partial<ReportTest> = {}): ReportTest => ({
      key, project: 'p', file: 'f', definedIn: null, titles: [key], outcome: 'expected', staticSkip: false, durationMs: 1, ran: true, serial: null, ...extra,
    });
    const tests = [report('good'), report('failed', { outcome: 'unexpected', durationMs: 30_000 }), report('cut', { ran: false }), report('skipped', { outcome: 'skipped', staticSkip: true })];
    expect(samplesFromReport(tests)).toEqual([{ key: 'good', durationMs: 1 }]);
  });
});
