import { createHash } from 'node:crypto';
import { repeatSuffix } from './atoms.js';
import type { Outcome, ReportTest } from './report.js';
import type { Sample } from './timings.js';

export const RUN_KIND = 'playwright-shard-balancer/run';

export type RunTest = {
  key: string;
  // A setup or teardown project test: it runs on every shard that needs it.
  setup?: true;
  repeat: number;
  outcome: Outcome;
  static_skip: boolean;
  duration_ms: number;
  ran: boolean;
};

export type RunRecord = {
  kind: typeof RUN_KIND;
  version: 1;
  shard: { current: number; total: number } | null;
  // "none": not sharded. "builtin": Playwright split it (see reason). "balanced": this tool split it.
  strategy: 'none' | 'builtin' | 'balanced';
  reason: string | null;
  timings_sha: string | null;
  plan_sha: string | null;
  // Every test the shard could see before the split. Null on Playwright < 1.62.
  corpus: { tests: number; sha: string } | null;
  predicted_ms: number[] | null;
  granularity: 'auto' | 'file' | null;
  workers: number | null;
  playwright: string | null;
  // The whole Playwright run, start-up included.
  wall_ms: number;
  // From the first test start to the last test end: what predicted_ms estimates.
  tests_ms: number;
  status: string;
  tests: RunTest[];
};

export function isRunRecord(data: unknown): data is RunRecord {
  return (data as { kind?: unknown })?.kind === RUN_KIND;
}

// A sample is the time a test took to pass in one run, retries included. Failed, interrupted
// and skipped tests give none: a failure often runs to the timeout. Setup tests run on every
// shard, so they are marked for the caller to fold into one sample per run.
export function samplesFromRun(record: RunRecord): (Sample & { setup: boolean })[] {
  return record.tests
    .filter((t) => t.ran && !t.static_skip && (t.outcome === 'expected' || t.outcome === 'flaky'))
    .map((t) => ({ key: t.key, durationMs: t.duration_ms, setup: t.setup === true }));
}

export function samplesFromReport(tests: ReportTest[]): Sample[] {
  return tests
    .filter((t) => t.ran && !t.staticSkip && (t.outcome === 'expected' || t.outcome === 'flaky'))
    .map((t) => ({ key: t.key, durationMs: t.durationMs }));
}

export type ShardActual = { shard: number; predicted_ms: number | null; tests_ms: number; total_ms: number; tests: number; status: string };

export type CheckResult = {
  ok: boolean;
  problems: string[];
  strategy: RunRecord['strategy'] | 'mixed';
  shards: ShardActual[];
  tests: number;
  duplicates: string[];
  missing: string[] | null;
  not_run: string[];
  // Slowest shard minus fastest, measured.
  spread_ms: number;
};

const testId = (t: { key: string; repeat: number }) => t.key + repeatSuffix(t.repeat);
const corpusSha = (ids: string[]) => createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 12);

// Proves a sharded run ran every test exactly once: all shards present, all on the same plan,
// no test in two shards, and the union equal to what every shard saw before the split.
export function check(records: RunRecord[], listed?: string[]): CheckResult {
  const problems: string[] = [];
  if (records.length === 0) problems.push('no run records');
  const totals = new Set(records.map((r) => r.shard?.total ?? 1));
  if (totals.size > 1) problems.push(`records disagree on the shard total: ${[...totals].join(', ')}`);
  const total = Math.max(...totals, 1);
  const seenShards = new Map<number, number>();
  for (const r of records) seenShards.set(r.shard?.current ?? 1, (seenShards.get(r.shard?.current ?? 1) ?? 0) + 1);
  const missingShards = Array.from({ length: total }, (_, k) => k + 1).filter((k) => !seenShards.has(k));
  if (missingShards.length) problems.push(`missing records for shard ${missingShards.join(', ')}`);
  const repeated = [...seenShards].filter(([, n]) => n > 1).map(([k]) => k);
  if (repeated.length) problems.push(`more than one record for shard ${repeated.join(', ')}`);

  const strategies = new Set(records.map((r) => r.strategy));
  const strategy = strategies.size === 1 ? [...strategies][0] : 'mixed';
  if (strategy === 'mixed') {
    const detail = records.map((r) => `${r.shard?.current ?? 1}=${r.strategy}${r.reason ? ` (${r.reason})` : ''}`).join(', ');
    problems.push(`shards split the suite differently: ${detail}`);
  }
  for (const field of ['timings_sha', 'plan_sha'] as const) {
    const values = new Set(records.filter((r) => r.strategy === 'balanced').map((r) => r[field]));
    if (values.size > 1) problems.push(`shards used different ${field.replace('_sha', '')}: ${[...values].join(', ')}`);
  }
  const corpora = new Set(records.filter((r) => r.corpus).map((r) => `${r.corpus!.tests}:${r.corpus!.sha}`));
  if (corpora.size > 1) problems.push(`shards saw different test sets before the split: ${[...corpora].join(', ')}`);

  const counts = new Map<string, number>();
  for (const r of records) for (const t of r.tests) if (!t.setup) counts.set(testId(t), (counts.get(testId(t)) ?? 0) + 1);
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([id]) => id).sort();
  if (duplicates.length) problems.push(`${duplicates.length} test(s) ran in more than one shard`);

  let missing: string[] | null = null;
  if (listed) {
    const ran = new Set(counts.keys());
    missing = listed.filter((id) => !ran.has(id));
  } else if (corpora.size === 1) {
    const [count, sha] = [...corpora][0].split(':');
    if (Number(count) !== counts.size || sha !== corpusSha([...counts.keys()])) {
      problems.push(`the shards ran ${counts.size} distinct tests, but each saw ${count} before the split; pass --list to name the missing ones`);
    }
  }
  if (missing?.length) problems.push(`${missing.length} listed test(s) ran in no shard`);

  const notRun = records.flatMap((r) => r.tests.filter((t) => !t.ran && !t.static_skip && !t.setup).map(testId)).sort();
  if (notRun.length) problems.push(`${notRun.length} test(s) did not run: the run was interrupted, stopped at max failures, or a setup project failed`);
  const shards = records
    .map((r) => ({
      shard: r.shard?.current ?? 1,
      predicted_ms: r.predicted_ms?.[(r.shard?.current ?? 1) - 1] ?? null,
      tests_ms: r.tests_ms,
      total_ms: r.wall_ms,
      tests: r.tests.filter((t) => !t.setup).length,
      status: r.status,
    }))
    .sort((a, b) => a.shard - b.shard);
  const actual = shards.map((s) => s.total_ms);
  return {
    ok: problems.length === 0,
    problems,
    strategy,
    shards,
    tests: counts.size,
    duplicates,
    missing,
    not_run: notRun,
    spread_ms: actual.length ? Math.max(...actual) - Math.min(...actual) : 0,
  };
}

export { corpusSha, testId };
