import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { addToAtom, type Atom, mergeLocked, repeatSuffix } from './atoms.js';
import { createEstimator, type Estimator } from './estimate.js';
import { balance, formatMs, type Plan, type SetupCosts } from './plan.js';
import { atLeast, dependencyProjects, testKey } from './report.js';
import { corpusSha, RUN_KIND, type RunRecord, type RunTest } from './run.js';
import { emptyTimings, loadTimings } from './timings.js';

export type ShardBalancerOptions = {
  // Timings file, relative to the config file. Default: shard-timings.json.
  timings?: string;
  // Where to write this run's record for `update` and `check`. "{shard}" becomes the shard number.
  record?: string;
  // "auto" keeps Playwright's own test groups (serial describes, non-parallel files) together.
  // "file" keeps every file together.
  granularity?: 'auto' | 'file';
  // Workers per shard that the plan packs for. A fixed number, not config.workers: Playwright
  // resolves that from the machine's CPUs, and every shard must compute the same plan. Default 1.
  workers?: number;
  // Fail the run instead of falling back to the built-in split, so one shard cannot split the
  // suite differently from the others. Also on with PLAYWRIGHT_SHARD_BALANCER_STRICT=1.
  strict?: boolean;
};

export const STRICT_ENV = 'PLAYWRIGHT_SHARD_BALANCER_STRICT';

type PreprocessParams = Parameters<NonNullable<Reporter['preprocess']>>[0];
type ParallelMode = 'none' | 'default' | 'serial' | 'parallel';
type InternalSuite = Suite & { _parallelMode?: ParallelMode };
type InternalTest = TestCase & { _locks?: string[] };

const log = (message: string) => process.stderr.write(`playwright-shard-balancer: ${message}\n`);
const toPosix = (p: string) => p.split(sep).join('/');

function fileSuiteOf(test: TestCase): Suite | undefined {
  let suite: Suite | undefined = test.parent;
  while (suite && suite.type !== 'file') suite = suite.parent;
  return suite;
}

// Mirrors Playwright's createTestGroups: tests outside parallel mode stay with their file;
// in parallel mode each test stands alone, except inside a serial or default-mode describe.
function groupOf(test: TestCase, base: string, exact: boolean): string {
  if (!exact) return base;
  let insideParallel = false;
  let sequential: InternalSuite | undefined;
  for (let parent = test.parent as InternalSuite | undefined; parent; parent = parent.parent as InternalSuite | undefined) {
    if (parent._parallelMode === 'serial' || parent._parallelMode === 'default') sequential = parent;
    insideParallel ||= parent._parallelMode === 'parallel';
  }
  if (!insideParallel) return base;
  if (sequential) return `${base} › ${sequential.titlePath().slice(3).join(' › ')}`;
  return `${base} › ${test.titlePath().slice(3).join(' › ')}`;
}

type Corpus = {
  atoms: Atom[];
  testsByAtom: Map<string, TestCase[]>;
  setup: SetupCosts;
  exact: boolean;
  keys: string[];
  locked: number;
  // False when Playwright 1.63+ tests carry no lock list, so lock groups could not be kept together.
  locksKnown: boolean;
};

export function buildCorpus(config: FullConfig, suite: Suite, estimator: Estimator, granularity: 'auto' | 'file'): Corpus {
  const rootDir = config.rootDir;
  const readonly = dependencyProjects(config.projects, suite.suites.map((s) => s.title));
  const atoms = new Map<string, Atom>();
  const byAtom = new Map<string, TestCase[]>();
  const locks = new Map<string, string[]>();
  const setup: SetupCosts = new Map();
  const keys: string[] = [];
  let locksKnown = true;
  const exact =
    granularity === 'auto' &&
    suite.suites.every((p) => readonly.has(p.title) || p.suites.every((f) => typeof (f as InternalSuite)._parallelMode === 'string'));
  for (const projectSuite of suite.suites) {
    const project = projectSuite.title;
    const tests = projectSuite.allTests();
    // Keys use the spec file, so tests that a shared helper defines in several specs stay distinct.
    const fileOf = (test: TestCase) => toPosix(relative(rootDir, fileSuiteOf(test)?.location?.file ?? test.location.file));
    if (readonly.has(project)) {
      let cost = 0;
      for (const t of tests) cost += estimator.estimate({ key: testKey(project, fileOf(t), t.titlePath().slice(3)), project, file: fileOf(t), staticSkip: t.expectedStatus === 'skipped' });
      setup.set(project, cost);
      continue;
    }
    const deps = [...dependencyProjects(config.projects, [project])].sort();
    for (const test of tests) {
      const key = testKey(project, fileOf(test), test.titlePath().slice(3));
      const groupFile = fileOf(test);
      const id = groupOf(test, testKey(project, groupFile, []), exact) + repeatSuffix(test.repeatEachIndex);
      const staticSkip = test.expectedStatus === 'skipped';
      const entry = { key, project, file: groupFile, staticSkip };
      addToAtom(atoms, id, entry, estimator.estimate(entry), staticSkip || estimator.isKnown(key), deps);
      (byAtom.get(id) ?? byAtom.set(id, []).get(id)!).push(test);
      const testLocks = (test as InternalTest)._locks;
      if (!Array.isArray(testLocks)) locksKnown = false;
      else if (testLocks.length) locks.set(id, [...(locks.get(id) ?? []), ...testLocks]);
      keys.push(key + repeatSuffix(test.repeatEachIndex));
    }
  }
  const merged = mergeLocked([...atoms.values()], locks);
  const testsByAtom = new Map([...merged.members].map(([id, ids]) => [id, ids.flatMap((m) => byAtom.get(m) ?? [])]));
  return {
    atoms: merged.atoms,
    testsByAtom,
    setup,
    exact,
    keys,
    locked: atoms.size - merged.atoms.length,
    locksKnown: locksKnown || !atLeast(config.version, 1, 63),
  };
}

export default class ShardBalancer implements Reporter {
  private options: ShardBalancerOptions;
  private config?: FullConfig;
  private record: Omit<RunRecord, 'tests' | 'wall_ms' | 'tests_ms' | 'status'> = {
    kind: RUN_KIND,
    version: 1,
    shard: null,
    strategy: 'none',
    reason: null,
    timings_sha: null,
    plan_sha: null,
    corpus: null,
    predicted_ms: null,
    granularity: null,
    workers: null,
    playwright: null,
  };
  private tests: TestCase[] = [];
  private setupProjects = new Set<string>();
  private durations = new Map<TestCase, number>();
  private firstStart = Infinity;
  private lastEnd = -Infinity;

  constructor(options: ShardBalancerOptions = {}) {
    if (options.granularity !== undefined && options.granularity !== 'auto' && options.granularity !== 'file') {
      throw new Error(`playwright-shard-balancer: granularity must be "auto" or "file", got ${JSON.stringify(options.granularity)}`);
    }
    if (options.workers !== undefined && !(Number.isInteger(options.workers) && options.workers >= 1)) {
      throw new Error(`playwright-shard-balancer: workers must be a positive integer, got ${JSON.stringify(options.workers)}`);
    }
    this.options = options;
  }

  printsToStdio(): boolean {
    return false;
  }

  async preprocess({ config, suite, testRun }: PreprocessParams): Promise<void> {
    this.config = config;
    this.record.playwright = config.version;
    if (!config.shard) return;
    this.record.shard = { current: config.shard.current, total: config.shard.total };
    this.record.strategy = 'builtin';
    const shardLabel = `shard ${config.shard.current}/${config.shard.total}`;
    const strict = this.options.strict ?? process.env[STRICT_ENV] === '1';
    const fallback = (reason: string) => {
      if (strict) throw new Error(`playwright-shard-balancer: ${shardLabel}: ${reason}; strict mode stops the run rather than split it differently from other shards`);
      this.record.reason = reason;
      log(`${shardLabel}: ${reason}; using Playwright's built-in sharding`);
    };

    const path = resolve(config.configFile ? dirname(config.configFile) : config.rootDir, this.options.timings ?? 'shard-timings.json');
    let loaded: ReturnType<typeof loadTimings> = { timings: emptyTimings(), sha: null };
    let readError: string | null = null;
    try {
      loaded = loadTimings(path);
    } catch (error) {
      readError = (error as Error).message;
    }
    const estimator = createEstimator(loaded.timings);
    const corpus = buildCorpus(config, suite, estimator, this.options.granularity ?? 'auto');
    this.record.corpus = { tests: corpus.keys.length, sha: corpusSha(corpus.keys) };
    if (readError) return fallback(`cannot read timings: ${readError}`);
    if (loaded.sha === null) return fallback(`no timings file at ${path}`);
    if (estimator.knownCount === 0) return fallback(`timings file ${path} has no entries`);
    if (corpus.atoms.length === 0) return fallback('no tests to balance');

    const workers = this.options.workers ?? 1;
    const plan: Plan = balance(corpus.atoms, config.shard.total, workers, corpus.setup);
    const mine = plan.shards[config.shard.current - 1];
    const keep = new Set<TestCase>(mine.atoms.flatMap((a) => corpus.testsByAtom.get(a.id) ?? []));
    excludeOthers(suite, dependencyProjects(config.projects, suite.suites.map((s) => s.title)), keep, testRun);
    testRun.skipSharding();

    this.record.strategy = 'balanced';
    this.record.timings_sha = loaded.sha;
    this.record.plan_sha = plan.sha;
    this.record.predicted_ms = plan.shards.map((s) => s.wall_ms);
    this.record.granularity = corpus.exact ? 'auto' : 'file';
    this.record.workers = workers;
    const walls = plan.shards.map((s) => s.wall_ms);
    const known = corpus.keys.length - plan.unknown_tests;
    log(
      `${shardLabel}: ${mine.files} files, ${mine.tests} tests, ~${formatMs(mine.wall_ms)} ` +
        `(all shards ${formatMs(Math.min(...walls))}-${formatMs(Math.max(...walls))}, ` +
        `largest group ${plan.largest ? formatMs(plan.largest.cost_ms) : '0s'}), ` +
        `timings ${loaded.sha}, ${known}/${corpus.keys.length} tests known, ${workers} worker(s), plan ${plan.sha}` +
        (corpus.locked ? `, ${corpus.locked} group(s) joined to others that share a lock` : '') +
        (corpus.exact || this.options.granularity === 'file' ? '' : ', Playwright internals not found so files are kept whole') +
        (corpus.locksKnown ? '' : ', lock information not found so tests that share a lock may run on different shards'),
    );
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config ??= config;
    this.record.playwright ??= config.version;
    if (!this.record.shard && config.shard) {
      // Playwright before 1.62 never calls preprocess, so it split the suite itself.
      this.record.shard = { current: config.shard.current, total: config.shard.total };
      this.record.strategy = 'builtin';
      this.record.reason = `Playwright ${config.version} has no preprocess hook (1.62+ needed)`;
      log(`shard ${config.shard.current}/${config.shard.total}: ${this.record.reason}; using Playwright's built-in sharding`);
    }
    this.setupProjects = dependencyProjects(config.projects, suite.suites.map((s) => s.title));
    this.tests = suite.allTests();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.durations.set(test, (this.durations.get(test) ?? 0) + result.duration);
    const start = result.startTime.getTime();
    this.firstStart = Math.min(this.firstStart, start);
    this.lastEnd = Math.max(this.lastEnd, start + result.duration);
  }

  async onEnd(result: FullResult): Promise<void> {
    if (!this.options.record || !this.config) return;
    const rootDir = this.config.rootDir;
    const tests: RunTest[] = this.tests.map((test) => {
      const project = test.parent.project()?.name ?? '';
      const key = testKey(project, toPosix(relative(rootDir, fileSuiteOf(test)?.location?.file ?? test.location.file)), test.titlePath().slice(3));
      return {
        key,
        ...(this.setupProjects.has(project) ? { setup: true as const } : {}),
        repeat: test.repeatEachIndex,
        outcome: test.outcome(),
        static_skip: test.expectedStatus === 'skipped',
        duration_ms: this.durations.get(test) ?? 0,
        ran: test.results.length > 0 && test.results.every((r) => r.status !== 'interrupted'),
      };
    });
    const testsMs = this.lastEnd > this.firstStart ? Math.round(this.lastEnd - this.firstStart) : 0;
    const record: RunRecord = { ...this.record, wall_ms: Math.round(result.duration), tests_ms: testsMs, status: result.status, tests };
    const shard = this.record.shard ? String(this.record.shard.current) : 'all';
    const base = this.config.configFile ? dirname(this.config.configFile) : rootDir;
    const out = resolve(base, this.options.record.replaceAll('{shard}', shard));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(record)}\n`);
  }
}

function excludeOthers(suite: Suite, readonly: Set<string>, keep: Set<TestCase>, testRun: PreprocessParams['testRun']) {
  for (const projectSuite of [...suite.suites]) {
    if (readonly.has(projectSuite.title)) continue;
    for (const fileSuite of [...projectSuite.suites]) {
      const tests = fileSuite.allTests();
      if (tests.every((t) => !keep.has(t))) testRun.exclude(fileSuite);
      else for (const t of tests) if (!keep.has(t)) testRun.exclude(t);
    }
  }
}
