#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Granularity } from './atoms.js';
import { parseDuration, parseShards, runCheck, runPlan, runSimulate, runUpdate } from './commands.js';
import { formatMs } from './plan.js';

const USAGE = `Usage:
  playwright-shard-balancer update   --timings <timings.json> <report.json | run-record.json>...
  playwright-shard-balancer simulate --timings <timings.json> --list <list.json> --shards <n | a-b> [--workers <n>] [--granularity file|test] [--overhead <90s>] [--target <12m>] [--out <file>]
  playwright-shard-balancer plan     --timings <timings.json> --list <list.json> --shards <n> --out-dir <dir> [--workers <n>] [--granularity file|test]
  playwright-shard-balancer check    <run-record.json>... [--list <list.json>] [--summary <file.md>]

<list.json>:       PLAYWRIGHT_JSON_OUTPUT_NAME=list.json npx playwright test --list --reporter=json > /dev/null
<run-record.json>: written by the reporter's "record" option`;

const OPTIONS = {
  timings: { type: 'string' },
  list: { type: 'string' },
  shards: { type: 'string' },
  workers: { type: 'string' },
  granularity: { type: 'string' },
  target: { type: 'string' },
  overhead: { type: 'string' },
  out: { type: 'string' },
  'out-dir': { type: 'string' },
  summary: { type: 'string' },
} as const;

class UsageError extends Error {}

function required(values: Record<string, string | undefined>, ...names: string[]): string[] {
  const missing = names.filter((n) => !values[n]);
  if (missing.length > 0) throw new UsageError(`missing ${missing.map((n) => `--${n}`).join(', ')}`);
  return names.map((n) => values[n] as string);
}

function emit(data: unknown, out?: string) {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}

const log = (message: string) => process.stderr.write(`playwright-shard-balancer: ${message}\n`);

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

function usage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function granularity(value: string | undefined): Granularity | undefined {
  if (value === undefined || value === 'file' || value === 'test') return value;
  throw new UsageError('--granularity must be "file" or "test"');
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: true });
  const noPositionals = () => {
    if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  };

  switch (command) {
    case 'update': {
      const [timings] = required(values, 'timings');
      if (positionals.length === 0) throw new UsageError('pass at least one JSON report or run record');
      const result = runUpdate({ timings, inputs: positionals });
      emit(result);
      for (const w of result.warnings) log(`warning: ${w}`);
      log(`${result.samples} samples from ${result.inputs} input(s), ${result.new_tests} new tests; ${result.tests} tests in ${timings} (${result.sha})`);
      return 0;
    }
    case 'simulate': {
      noPositionals();
      const [timings, list, shards] = required(values, 'timings', 'list', 'shards');
      const result = runSimulate({
        timings,
        list,
        shards: usage(() => parseShards(shards)),
        workers: positiveInt(values.workers, 'workers', 1),
        granularity: granularity(values.granularity),
        targetMs: values.target === undefined ? undefined : usage(() => parseDuration(values.target!)),
        overheadMs: values.overhead === undefined ? undefined : usage(() => parseDuration(values.overhead!)),
      });
      emit(result, values.out);
      for (const r of result.rows) {
        const pct = r.builtin_ms ? Math.round((r.saved_ms / r.builtin_ms) * 100) : 0;
        log(`${r.shards} shards: built-in ${formatMs(r.builtin_ms)}, balanced ${formatMs(r.balanced_ms)} (${pct}% faster), best possible ${formatMs(r.lower_bound_ms)}`);
      }
      if (result.unknown_tests) log(`${result.unknown_tests} of ${result.tests} tests have no timings and use estimates`);
      if (values.target !== undefined) {
        log(result.recommended_shards ? `${result.recommended_shards} shards meet ${values.target}` : `no shard count in range meets ${values.target}`);
      }
      return 0;
    }
    case 'plan': {
      noPositionals();
      const [timings, list, shards, outDir] = required(values, 'timings', 'list', 'shards', 'out-dir');
      const result = runPlan({
        timings,
        list,
        shards: positiveInt(shards, 'shards', 1),
        workers: positiveInt(values.workers, 'workers', 1),
        granularity: granularity(values.granularity) ?? 'file',
        outDir,
      });
      log(`wrote ${result.files.length} test lists to ${outDir}; slowest shard ~${formatMs(result.makespan_ms)}, plan ${result.sha}`);
      return 0;
    }
    case 'check': {
      if (positionals.length === 0) throw new UsageError('pass the run record of every shard');
      const result = runCheck({ records: positionals, list: values.list, summary: values.summary });
      emit(result);
      if (result.ok) log(`ok: ${result.tests} tests ran exactly once across ${result.shards.length} shard(s); measured spread ${formatMs(result.spread_ms)}`);
      else for (const p of result.problems) log(p);
      return result.ok ? 0 : 1;
    }
    default:
      throw new UsageError(command ? `unknown command "${command}"` : 'missing command');
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
    process.stderr.write(`\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = 1;
  }
}
