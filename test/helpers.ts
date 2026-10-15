import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listedTests } from '../src/report.js';
import { testId } from '../src/run.js';

export const fixtureConfig = fileURLToPath(new URL('./fixtures/pw/playwright.config.ts', import.meta.url));
export const reporterPath = fileURLToPath(new URL('../dist/reporter.js', import.meta.url));
export const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

// Fixture switches; a caller's own values must not leak in.
const FIXTURE_ENV = /^(PWSB_|FULLY_PARALLEL|WORKERS|FIXTURE_SCALE|FAIL_|PLAYWRIGHT_JSON_OUTPUT|PLAYWRIGHT_SHARD_BALANCER_)/;

export type FixtureRun = { report: any; stderr: string; status: number | null };

// Runs the fixture and returns its raw output, for runs that may print no report.
export function runRaw(args: string[], env: Record<string, string> = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !FIXTURE_ENV.test(key)));
  const result = spawnSync('npx', ['playwright', 'test', '--config', fixtureConfig, ...args], {
    encoding: 'utf8',
    env: { ...inherited, ...env },
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return result;
}

export function runFixture(args: string[], env: Record<string, string> = {}): FixtureRun {
  const result = runRaw(args, env);
  if (!result.stdout) throw new Error(`playwright produced no output: ${result.stderr}`);
  return { report: JSON.parse(result.stdout), stderr: result.stderr, status: result.status };
}

// Runs with the balancer reporter on, using the given options.
export function runBalanced(args: string[], options: Record<string, unknown>, env: Record<string, string> = {}): FixtureRun {
  return runFixture(args, { PWSB_REPORTER: reporterPath, PWSB_OPTIONS: JSON.stringify(options), ...env });
}

// The non-setup tests in a report, with repeats numbered, sorted.
export function membership(report: unknown): string[] {
  const seen = new Map<string, number>();
  return listedTests(report)
    .map((t) => {
      const repeat = seen.get(t.key) ?? 0;
      seen.set(t.key, repeat + 1);
      return testId({ key: t.key, repeat });
    })
    .sort();
}
