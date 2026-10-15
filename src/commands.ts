import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomsFromTests, type Atom, type Granularity } from './atoms.js';
import { createEstimator, type Estimator } from './estimate.js';
import { balance, builtin, formatMs, type Plan, type SetupCosts, summary } from './plan.js';
import { atLeast, testKey, isJsonReport, type Listing, listing, type ReportTest, reportErrors, reportFullyParallel, reportVersion } from './report.js';
import { check, type CheckResult, isRunRecord, type RunRecord, samplesFromReport, samplesFromRun, testId } from './run.js';
import { addSamples, loadTimings, median, type Sample, saveTimings, sha } from './timings.js';

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${(error as Error).message}`);
  }
};

// A list with errors is missing the tests of any spec that failed to load. Setup and teardown
// projects are kept apart: they run in full on every shard that needs them.
function readList(file: string): Listing & { report: unknown } {
  const report = readJson(file);
  const listed = listing(report);
  const errors = reportErrors(report);
  if (errors.length > 0) throw new Error(`${file} has errors: ${errors[0]}`);
  if (listed.tests.length === 0) throw new Error(`no tests in ${file}`);
  return { report, ...listed };
}

function setupCosts(listed: Listing, estimator: Estimator): SetupCosts {
  const costs: SetupCosts = new Map();
  for (const t of listed.setupTests) costs.set(t.project, (costs.get(t.project) ?? 0) + estimator.estimate(t));
  return costs;
}

const atomsOf = (listed: Listing, estimator: Estimator, granularity: Granularity): Atom[] => atomsFromTests(listed.tests, estimator, granularity, listed.deps);

const SERIAL_LIST = '--granularity test needs a list from Playwright 1.63+, which marks serial describes; use --granularity file';

function readTimings(file: string) {
  const loaded = loadTimings(file);
  if (loaded.sha === null) throw new Error(`no timings file at ${file}`);
  return loaded;
}

export type UpdateResult = {
  timings: string;
  sha: string;
  inputs: number;
  skipped_inputs: number;
  samples: number;
  new_tests: number;
  tests: number;
  warnings: string[];
};

export function runUpdate(opts: { timings: string; inputs: string[]; today?: string }): UpdateResult {
  if (opts.inputs.length === 0) throw new Error('no inputs: pass JSON reports or run records');
  const { timings } = loadTimings(opts.timings);
  const samples: Sample[] = [];
  const warnings: string[] = [];
  const applied = new Set(timings.applied ?? []);
  const fresh: string[] = [];
  const setupSamples = new Map<string, number[]>();
  let skipped = 0;
  for (const input of opts.inputs) {
    const text = readFileSync(input, 'utf8');
    const digest = sha(text);
    if (applied.has(digest)) {
      skipped++;
      warnings.push(`${input}: already merged, skipped`);
      continue;
    }
    applied.add(digest);
    fresh.push(digest);
    const data = readJson(input);
    if (isRunRecord(data)) {
      for (const s of samplesFromRun(data)) {
        if (!s.setup) samples.push(s);
        else (setupSamples.get(s.key) ?? setupSamples.set(s.key, []).get(s.key)!).push(s.durationMs);
      }
    } else if (isJsonReport(data)) {
      // A report merged from shards lists each setup test once per shard. Merged reports and those
      // from Playwright before 1.64 do not mark setup projects, so without --repeat-each a key that
      // repeats in one report is such a test: it gives one sample.
      const listed = listing(data);
      const repeatEach = new Map(((data as { config?: { projects?: { name: string; repeatEach?: number }[] } }).config?.projects ?? []).map((p) => [p.name, p.repeatEach ?? 1]));
      const repeated = (t: ReportTest) => (repeatEach.get(t.project) ?? 1) > 1;
      samples.push(...samplesFromReport(listed.tests.filter(repeated)));
      const once = new Map<string, number[]>();
      for (const s of samplesFromReport(listed.tests.filter((t) => !repeated(t)))) (once.get(s.key) ?? once.set(s.key, []).get(s.key)!).push(s.durationMs);
      for (const [key, values] of once) samples.push({ key, durationMs: median(values) });
      for (const s of samplesFromReport(listed.setupTests)) (setupSamples.get(s.key) ?? setupSamples.set(s.key, []).get(s.key)!).push(s.durationMs);
      const errors = reportErrors(data);
      if (errors.length) warnings.push(`${input}: ${errors[0]}`);
    } else {
      throw new Error(`${input} is neither a Playwright JSON report nor a run record`);
    }
  }
  // One update is one run: a setup test recorded by every shard gives one sample, not one per shard.
  for (const [key, values] of setupSamples) samples.push({ key, durationMs: median(values) });
  const before = new Set(Object.keys(timings.tests));
  const updated = addSamples(timings, samples, opts.today ?? new Date().toISOString().slice(0, 10), fresh);
  const savedSha = saveTimings(opts.timings, updated);
  return {
    timings: opts.timings,
    sha: savedSha,
    inputs: opts.inputs.length,
    skipped_inputs: skipped,
    samples: samples.length,
    new_tests: new Set(samples.map((s) => s.key).filter((k) => !before.has(k))).size,
    tests: Object.keys(updated.tests).length,
    warnings,
  };
}

export type SimulateRow = {
  shards: number;
  builtin_ms: number;
  balanced_ms: number;
  lower_bound_ms: number;
  saved_ms: number;
  // Wall time of the slowest shard plus the per-shard overhead: what CI waits for.
  elapsed_ms: number;
  // Machine time across all shards, overhead included: what CI pays for.
  machine_ms: number;
};

export type SimulateResult = {
  workers: number;
  overhead_ms: number;
  granularity: Granularity;
  builtin_granularity: Granularity;
  tests: number;
  unknown_tests: number;
  total_ms: number;
  setup_ms: Record<string, number>;
  rows: SimulateRow[];
  recommended_shards: number | null;
  detail: { builtin: ReturnType<typeof summary>; balanced: ReturnType<typeof summary> } | null;
};

export function parseShards(value: string): number[] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(value);
  const from = Number(m?.[1]);
  const to = Number(m?.[2] ?? m?.[1]);
  if (!m || from < 1 || to < from || to > 256) throw new Error(`--shards must be a number or a range like 2-8, got "${value}"`);
  return Array.from({ length: to - from + 1 }, (_, k) => from + k);
}

export function parseDuration(value: string): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!m || !value) throw new Error(`durations look like 90s, 12m or 1h30m, got "${value}"`);
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

export type SimulateOptions = {
  list: string;
  timings: string;
  shards: number[];
  workers: number;
  // Default: "test" for a fullyParallel suite, as the reporter would split it, else "file".
  granularity?: Granularity;
  overheadMs?: number;
  targetMs?: number;
};

export function runSimulate(opts: SimulateOptions): SimulateResult {
  const listed = readList(opts.list);
  const estimator = createEstimator(readTimings(opts.timings).timings);
  const setup = setupCosts(listed, estimator);
  // Without fullyParallel, Playwright's own groups are whole files.
  const builtinGranularity: Granularity = reportFullyParallel(listed.report) ? 'test' : 'file';
  const granularity = opts.granularity ?? builtinGranularity;
  if (granularity === 'test' && !atLeast(reportVersion(listed.report), 1, 63)) throw new Error(SERIAL_LIST);
  const atoms = atomsOf(listed, estimator, granularity);
  const builtinAtoms = builtinGranularity === granularity ? atoms : atomsOf(listed, estimator, builtinGranularity);
  const overhead = opts.overheadMs ?? 0;
  const plans = opts.shards.map((n) => ({ b: builtin(builtinAtoms, n, opts.workers, setup, listed.phases), p: balance(atoms, n, opts.workers, setup, listed.phases) }));
  const rows = plans.map(({ b, p }) => ({
    shards: p.shards.length,
    builtin_ms: b.makespan_ms,
    balanced_ms: p.makespan_ms,
    lower_bound_ms: p.lower_bound_ms,
    saved_ms: b.makespan_ms - p.makespan_ms,
    elapsed_ms: p.makespan_ms + overhead,
    machine_ms: p.shards.reduce((acc, s) => acc + s.wall_ms + overhead, 0),
  }));
  const target = opts.targetMs;
  return {
    workers: opts.workers,
    overhead_ms: overhead,
    granularity,
    builtin_granularity: builtinGranularity,
    tests: listed.tests.length,
    unknown_tests: plans[0]?.p.unknown_tests ?? 0,
    total_ms: plans[0]?.p.total_ms ?? 0,
    setup_ms: Object.fromEntries(setup),
    rows,
    recommended_shards: target === undefined ? null : (rows.find((r) => r.elapsed_ms <= target)?.shards ?? null),
    detail: plans.length === 1 ? { builtin: summary(plans[0].b), balanced: summary(plans[0].p) } : null,
  };
}

export type PlanResult = ReturnType<typeof summary> & { files: string[] };

// For Playwright < 1.62, or CI that prefers one planning job: one --test-list file per shard.
export function runPlan(opts: { list: string; timings: string; shards: number; workers: number; granularity: Granularity; outDir: string }): PlanResult {
  const listed = readList(opts.list);
  if (opts.granularity === 'test' && !atLeast(reportVersion(listed.report), 1, 63)) throw new Error(SERIAL_LIST);
  const seen = new Set<string>();
  for (const t of listed.tests) {
    if (seen.has(t.key)) throw new Error(`"${t.key}" is listed twice (--repeat-each?); a --test-list cannot split repeats, use the reporter`);
    seen.add(t.key);
    // Playwright splits a --test-list line at "›" and at line breaks, and trims each part.
    if ([t.project, t.file, ...t.titles].some((part) => part.includes('›') || /[\r\n]/.test(part) || part !== part.trim())) {
      throw new Error(`"${t.key}" has "›", a line break, or a leading or trailing space in a name, which --test-list cannot express; use the reporter`);
    }
    if (t.definedIn) {
      throw new Error(`"${t.key}" is defined in ${t.definedIn}, and a --test-list line for it would select it in every spec that uses that file; use the reporter`);
    }
  }
  // A --test-list line also selects every test whose title path it starts.
  for (const t of listed.tests) {
    for (let n = 1; n < t.titles.length; n++) {
      const prefix = testKey(t.project, t.file, t.titles.slice(0, n));
      if (seen.has(prefix)) throw new Error(`"${prefix}" is a test and also starts the title of "${t.key}", so its --test-list line would select both; use the reporter`);
    }
  }
  const estimator = createEstimator(readTimings(opts.timings).timings);
  const plan = balance(atomsOf(listed, estimator, opts.granularity), opts.shards, opts.workers, setupCosts(listed, estimator), listed.phases);
  mkdirSync(opts.outDir, { recursive: true });
  const files = plan.shards.map((shard) => {
    const file = join(opts.outDir, `shard-${shard.shard}.txt`);
    const lines = shard.atoms.flatMap((a) => a.keys);
    writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '# no tests in this shard\n');
    return file;
  });
  const result = { ...summary(plan), files };
  writeFileSync(join(opts.outDir, 'plan.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function runCheck(opts: { records: string[]; list?: string; summary?: string }): CheckResult {
  const records = opts.records.map((file) => {
    const data = readJson(file);
    if (!isRunRecord(data)) throw new Error(`${file} is not a run record; set the reporter's "record" option`);
    return data as RunRecord;
  });
  let listed: string[] | undefined;
  if (opts.list) {
    // A list from Playwright before 1.64 does not mark setup projects; the records do.
    const setup = new Set(records.flatMap((r) => r.tests.filter((t) => t.setup).map((t) => t.key)));
    const seen = new Map<string, number>();
    listed = readList(opts.list).tests.filter((t) => !setup.has(t.key)).map((t) => {
      const repeat = seen.get(t.key) ?? 0;
      seen.set(t.key, repeat + 1);
      return testId({ key: t.key, repeat });
    });
  }
  const result = check(records, listed);
  if (opts.summary) appendFileSync(resolve(opts.summary), markdown(result));
  return result;
}

export function markdown(result: CheckResult): string {
  const lines = [
    `### Shard balance: ${result.ok ? 'ok' : 'problems found'}`,
    '',
    `${result.tests} tests, strategy ${result.strategy}, slowest shard minus fastest ${formatMs(result.spread_ms)}.`,
    '',
    '| Shard | Tests | Predicted | Test time | Whole run | Status |',
    '|---|---|---|---|---|---|',
    ...result.shards.map(
      (s) => `| ${s.shard} | ${s.tests} | ${s.predicted_ms === null ? '-' : formatMs(s.predicted_ms)} | ${formatMs(s.tests_ms)} | ${formatMs(s.total_ms)} | ${s.status} |`,
    ),
  ];
  if (result.problems.length) lines.push('', ...result.problems.map((p) => `- ${p}`));
  return `${lines.join('\n')}\n\n`;
}
