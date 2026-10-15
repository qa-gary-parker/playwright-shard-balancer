import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const MAX_SAMPLES = 5;
export const PRUNE_AFTER_DAYS = 30;
// Inputs already merged, by content sha, so a re-uploaded artifact is not counted twice.
export const MAX_APPLIED = 200;

export type TimingEntry = { samples: number[]; seen: string };
export type Timings = { version: 1; tests: Record<string, TimingEntry>; applied?: string[] };
export type Sample = { key: string; durationMs: number };

export function emptyTimings(): Timings {
  return { version: 1, tests: {} };
}

export function parseTimings(text: string, source: string): Timings {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  const timings = data as Timings;
  if (timings?.version !== 1) throw new Error(`${source} has unsupported version ${JSON.stringify(timings?.version)}`);
  if (typeof timings.tests !== 'object' || timings.tests === null) throw new Error(`${source} has no "tests" object`);
  if (timings.applied !== undefined && !(Array.isArray(timings.applied) && timings.applied.every((a) => typeof a === 'string'))) {
    throw new Error(`${source} has an invalid "applied" list`);
  }
  for (const [key, entry] of Object.entries(timings.tests)) {
    const valid =
      Array.isArray(entry?.samples) &&
      entry.samples.length > 0 &&
      entry.samples.every((s) => Number.isInteger(s) && s >= 0) &&
      typeof entry.seen === 'string';
    if (!valid) throw new Error(`${source} has an invalid entry for "${key}"`);
  }
  return timings;
}

// A missing file is empty timings; anything else unreadable throws.
export function loadTimings(path: string): { timings: Timings; sha: string | null } {
  if (!existsSync(path)) return { timings: emptyTimings(), sha: null };
  const text = readFileSync(path, 'utf8');
  return { timings: parseTimings(text, path), sha: sha(text) };
}

export function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// Sorted keys, so the same timings always serialise to the same bytes and the same sha.
export function serializeTimings(timings: Timings): string {
  const tests: Record<string, TimingEntry> = {};
  for (const key of Object.keys(timings.tests).sort()) tests[key] = timings.tests[key];
  return `${JSON.stringify({ version: 1, ...(timings.applied?.length ? { applied: timings.applied } : {}), tests }, null, 1)}\n`;
}

export function saveTimings(path: string, timings: Timings): string {
  const text = serializeTimings(timings);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return sha(text);
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

// Adds one sample per key (the newest last), keeps the last MAX_SAMPLES, and drops entries
// unseen for PRUNE_AFTER_DAYS. A key sampled twice in one batch (--repeat-each) keeps both.
export function addSamples(timings: Timings, samples: Sample[], today: string, applied: string[] = []): Timings {
  const tests: Record<string, TimingEntry> = {};
  for (const [key, entry] of Object.entries(timings.tests)) {
    if (daysBetween(entry.seen, today) <= PRUNE_AFTER_DAYS) tests[key] = { samples: [...entry.samples], seen: entry.seen };
  }
  for (const { key, durationMs } of samples) {
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;
    const entry = (tests[key] ??= { samples: [], seen: today });
    entry.samples.push(Math.round(durationMs));
    entry.samples = entry.samples.slice(-MAX_SAMPLES);
    entry.seen = today;
  }
  const log = [...(timings.applied ?? []), ...applied].slice(-MAX_APPLIED);
  return { version: 1, tests, ...(log.length ? { applied: log } : {}) };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
