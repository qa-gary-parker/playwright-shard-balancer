import { stripVTControlCharacters } from 'node:util';

export type Outcome = 'expected' | 'unexpected' | 'flaky' | 'skipped';

export type ReportTest = {
  key: string;
  project: string;
  // The spec file Playwright loaded, which is also the file it groups by.
  file: string;
  // The helper file that defines the test, when it is not the spec file.
  definedIn: string | null;
  titles: string[];
  outcome: Outcome;
  // Skipped before it ran: test.skip(), test.fixme() or a skip annotation.
  staticSkip: boolean;
  durationMs: number;
  // False when the run never started the test: interrupted, stopped by maxFailures, or a --list report.
  ran: boolean;
  // "line:column" of the outermost serial describe around the test (Playwright 1.63+), else null.
  serial: string | null;
};

type JsonTest = {
  projectName: string;
  status: Outcome;
  expectedStatus?: string;
  results: { duration: number; status: string }[];
  annotations?: { type: string; location?: { line: number; column: number } }[];
};
type JsonSpec = { title: string; file: string; line?: number; column?: number; tests: JsonTest[] };
type JsonSuite = { title: string; file: string; specs?: JsonSpec[]; suites?: JsonSuite[] };

// A test's identity: "[project] › spec file › describe › title". For a test defined in its spec
// file, this is also its line in a Playwright --test-list file.
export function testKey(project: string, file: string, titles: string[]): string {
  return [`[${project}]`, file, ...titles].join(' › ');
}

// Playwright adds one "serial" annotation per enclosing serial describe, outermost first.
function serialOf(test: JsonTest): string | null {
  const location = test.annotations?.find((a) => a.type === 'serial')?.location;
  return location ? `${location.line}:${location.column}` : null;
}

export function isJsonReport(data: unknown): boolean {
  return Array.isArray((data as { suites?: unknown })?.suites);
}

// Walks the output of `playwright test --reporter=json`, with or without --list. The report is
// file-major and puts a suite's own tests before its describes; sorting by project, then file,
// then line restores the order Playwright groups them in. Anonymous describes are left out of
// titles, as in test.titlePath().
export function flattenReport(report: unknown): ReportTest[] {
  if (!isJsonReport(report)) throw new Error('not a Playwright JSON report: missing "suites"');
  const projects = ((report as { config?: { projects?: { name: string }[] } }).config?.projects ?? []).map((p) => p.name);
  const projectIndex = (name: string) => {
    if (!projects.includes(name)) projects.push(name);
    return projects.indexOf(name);
  };
  const tests: (ReportTest & { line: number; column: number; fileIndex: number; projectIndex: number })[] = [];
  const walk = (suite: JsonSuite, describes: string[], fileIndex: number, file: string) => {
    for (const spec of suite.specs ?? []) {
      const titles = [...describes, spec.title];
      for (const test of spec.tests) {
        tests.push({
          key: testKey(test.projectName, file, titles),
          project: test.projectName,
          file,
          definedIn: spec.file === file ? null : spec.file,
          titles,
          outcome: test.status,
          staticSkip: test.expectedStatus === 'skipped',
          durationMs: test.results.reduce((sum, r) => sum + r.duration, 0),
          ran: test.results.length > 0 && test.results.every((r) => r.status !== 'interrupted'),
          serial: serialOf(test),
          line: spec.line ?? 0,
          column: spec.column ?? 0,
          fileIndex,
          projectIndex: projectIndex(test.projectName),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, child.title ? [...describes, child.title] : describes, fileIndex, file);
  };
  (report as { suites: JsonSuite[] }).suites.forEach((fileSuite, i) => walk(fileSuite, [], i, fileSuite.file));
  // Stable sort: tests made in a loop share a line and keep report order.
  tests.sort((a, b) => a.projectIndex - b.projectIndex || a.fileIndex - b.fileIndex || a.line - b.line || a.column - b.column);
  return tests.map(({ line, column, fileIndex, projectIndex, ...test }) => test);
}

// Run-level errors: a spec that failed to load, a global setup failure, or a run stopped early.
export function reportErrors(report: unknown): string[] {
  const errors = (report as { errors?: { message?: string }[] }).errors ?? [];
  return errors.map((e) => stripVTControlCharacters(e.message ?? '').split('\n')[0]);
}

export function reportVersion(report: unknown): string | null {
  const version = (report as { config?: { version?: unknown } }).config?.version;
  return typeof version === 'string' ? version : null;
}

export function atLeast(version: string | null, major: number, minor: number): boolean {
  const [a, b] = (version ?? '0.0').split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

export function reportFullyParallel(report: unknown): boolean {
  return (report as { config?: { fullyParallel?: unknown } }).config?.fullyParallel === true;
}

type ProjectDeps = { name: string; dependencies?: string[]; teardown?: string };

// Projects that run only as a setup or teardown dependency of the given projects, the way
// Playwright's buildProjectsClosure marks them. Playwright never shards them.
export function dependencyProjects(projects: ProjectDeps[], names: string[]): Set<string> {
  const byName = new Map(projects.map((p) => [p.name, p]));
  const deps = new Set<string>();
  const visit = (name: string, depth: number) => {
    if (depth > 0) {
      if (deps.has(name)) return;
      deps.add(name);
    }
    const project = byName.get(name);
    for (const dep of project?.dependencies ?? []) visit(dep, depth + 1);
    if (project?.teardown) visit(project.teardown, depth + 1);
  };
  for (const name of new Set(names)) visit(name, 0);
  return deps;
}

// The phase Playwright runs each setup and teardown project in (createPhasesTask). A project waits
// for its dependencies, and a teardown also waits for every project that needs its setup. The
// projects of one phase run side by side on the workers.
export function setupPhases(projects: ProjectDeps[], names: string[]): Map<string, number> {
  const byName = new Map(projects.map((p) => [p.name, p]));
  const setups = dependencyProjects(projects, names);
  const running = new Set([...names, ...setups]);
  const needs = (name: string, setup: string): boolean => dependencyProjects(projects, [name]).has(setup);
  const waitsFor = new Map([...running].map((name) => [name, (byName.get(name)?.dependencies ?? []).filter((d) => running.has(d))]));
  for (const setup of running) {
    const teardown = byName.get(setup)?.teardown;
    if (teardown && running.has(teardown)) waitsFor.get(teardown)!.push(setup, ...[...running].filter((p) => p !== teardown && needs(p, setup)));
  }
  const phases = new Map<string, number>();
  const phaseOf = (name: string, path = new Set<string>()): number => {
    if (phases.has(name)) return phases.get(name)!;
    if (path.has(name)) return 0;
    path.add(name);
    const phase = Math.max(-1, ...(waitsFor.get(name) ?? []).map((d) => phaseOf(d, path))) + 1;
    path.delete(name);
    phases.set(name, phase);
    return phase;
  };
  return new Map([...setups].map((name) => [name, phaseOf(name)]));
}

export type Listing = {
  // Tests that sharding splits.
  tests: ReportTest[];
  // Tests of setup and teardown projects, which run on every shard that needs them.
  setupTests: ReportTest[];
  // For each project with tests, the setup and teardown projects it needs, sorted.
  deps: Map<string, string[]>;
  phases: Map<string, number>;
};

// The report's filteredProjects carry dependencies and teardown; its projects do not.
export function listing(report: unknown): Listing {
  const all = flattenReport(report);
  const projects = (report as { config?: { filteredProjects?: ProjectDeps[] } }).config?.filteredProjects ?? [];
  const setup = dependencyProjects(projects, all.map((t) => t.project));
  const tests = all.filter((t) => !setup.has(t.project));
  const deps = new Map<string, string[]>();
  for (const name of new Set(tests.map((t) => t.project))) deps.set(name, [...dependencyProjects(projects, [name])].sort());
  return { tests, setupTests: all.filter((t) => setup.has(t.project)), deps, phases: setupPhases(projects, all.map((t) => t.project)) };
}

export function listedTests(report: unknown): ReportTest[] {
  return listing(report).tests;
}
