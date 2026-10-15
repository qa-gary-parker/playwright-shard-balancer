import { createHash } from 'node:crypto';
import type { Atom } from './atoms.js';
import { type Item, lowerBound, partition, wallTime } from './partition.js';

// Setup and teardown projects: the time each adds to every shard that needs it.
export type SetupCosts = Map<string, number>;

export type ShardPlan = {
  shard: number;
  atoms: Atom[];
  tests: number;
  files: number;
  sum_ms: number;
  setup_ms: number;
  // Estimated: setup, then the atoms packed onto the shard's workers.
  wall_ms: number;
};

export type Plan = {
  strategy: 'balanced' | 'builtin';
  algorithm: string;
  shards: ShardPlan[];
  total_ms: number;
  makespan_ms: number;
  lower_bound_ms: number;
  largest: { id: string; cost_ms: number } | null;
  unknown_tests: number;
  // The same atoms in the same shards give the same sha, on any machine.
  sha: string;
};

function setupTime(atoms: Atom[], setup: SetupCosts): number {
  let sum = 0;
  for (const dep of new Set(atoms.flatMap((a) => a.deps))) sum += setup.get(dep) ?? 0;
  return sum;
}

const toItems = (atoms: Atom[]): Item[] => atoms.map((a) => ({ cost: a.cost, order: a.order }));

// No plan beats this: the shard with the most work pays at least the cheapest setup, and the
// shard with the largest atom pays that atom's setup.
function bound(atoms: Atom[], shards: number, workers: number, setup: SetupCosts): number {
  let cheapest = Infinity;
  let single = 0;
  for (const a of atoms) {
    const own = setupTime([a], setup);
    cheapest = Math.min(cheapest, own);
    single = Math.max(single, a.cost + own);
  }
  return atoms.length ? Math.max(lowerBound(toItems(atoms), shards, workers) + cheapest, single) : 0;
}

function build(strategy: Plan['strategy'], algorithm: string, atoms: Atom[], bins: number[][], workers: number, setup: SetupCosts): Plan {
  const items = toItems(atoms);
  const shards = bins.map((bin, k) => {
    const list = [...bin].sort((a, b) => atoms[a].order - atoms[b].order).map((i) => atoms[i]);
    const setupMs = setupTime(list, setup);
    return {
      shard: k + 1,
      atoms: list,
      tests: list.reduce((acc, a) => acc + a.keys.length, 0),
      files: new Set(list.map((a) => `${a.project}\0${a.file}`)).size,
      sum_ms: list.reduce((acc, a) => acc + a.cost, 0),
      setup_ms: setupMs,
      wall_ms: setupMs + wallTime(items, bin, workers),
    };
  });
  const largest = atoms.reduce<Atom | null>((best, a) => (!best || a.cost > best.cost ? a : best), null);
  const hash = createHash('sha256');
  for (const shard of shards) hash.update(`${shard.shard}:${shard.atoms.map((a) => a.id).join('\n')}\n`);
  return {
    strategy,
    algorithm,
    shards,
    total_ms: atoms.reduce((acc, a) => acc + a.cost, 0),
    makespan_ms: Math.max(0, ...shards.map((s) => s.wall_ms)),
    lower_bound_ms: bound(atoms, bins.length, workers, setup),
    largest: largest && { id: largest.id, cost_ms: largest.cost },
    unknown_tests: atoms.reduce((acc, a) => acc + a.unknown, 0),
    sha: hash.digest('hex').slice(0, 12),
  };
}

const spread = (plan: Plan) => plan.shards.reduce((acc, s) => acc + s.wall_ms * s.wall_ms, 0);

// When projects need different setup projects, a shard pays for the setup of every family it
// hosts. This candidate gives each family its own shards, sized by its work.
function familyBins(atoms: Atom[], shards: number, workers: number, setup: SetupCosts): number[][] | null {
  const families = new Map<string, number[]>();
  atoms.forEach((a, i) => (families.get(a.deps.join('\0')) ?? families.set(a.deps.join('\0'), []).get(a.deps.join('\0'))!).push(i));
  const list = [...families.values()].map((indices) => {
    const members = indices.map((i) => atoms[i]);
    return { indices, setup: setupTime(members, setup), work: members.reduce((acc, a) => acc + a.cost, 0) };
  });
  if (list.length < 2 || list.every((f) => f.setup === 0)) return null;
  const bins: number[][] = Array.from({ length: shards }, () => []);
  if (shards < list.length) {
    const packed = partition(list.map((f, k) => ({ cost: f.work + f.setup, order: k })), shards, 1);
    packed.bins.forEach((bin, s) => bin.forEach((k) => bins[s].push(...list[k].indices)));
    return bins;
  }
  const counts = list.map(() => 1);
  for (let extra = shards - list.length; extra > 0; extra--) {
    let best = 0;
    for (let k = 1; k < list.length; k++) {
      if (list[k].work / counts[k] + list[k].setup > list[best].work / counts[best] + list[best].setup) best = k;
    }
    counts[best]++;
  }
  let next = 0;
  list.forEach((family, k) => {
    const sub = family.indices.map((i) => atoms[i]);
    for (const bin of partition(toItems(sub), counts[k], workers).bins) bins[next++].push(...bin.map((j) => family.indices[j]));
  });
  return bins;
}

export function balance(atoms: Atom[], shards: number, workers = 1, setup: SetupCosts = new Map()): Plan {
  const result = partition(toItems(atoms), shards, workers);
  const candidates = [build('balanced', result.algorithm, atoms, result.bins, workers, setup)];
  const families = familyBins(atoms, shards, workers, setup);
  if (families) candidates.push(build('balanced', 'setup-families', atoms, families, workers, setup));
  candidates.sort((a, b) => a.makespan_ms - b.makespan_ms || spread(a) - spread(b));
  return candidates[0];
}

// Playwright's own split (filterForShard): contiguous runs of groups, sized by test count.
export function builtin(atoms: Atom[], shards: number, workers = 1, setup: SetupCosts = new Map()): Plan {
  const active = atoms.map((a) => a.active);
  const sizes = active.some(Boolean) ? active : atoms.map((a) => a.keys.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  const shardSizes = Array.from({ length: shards }, () => Math.floor(total / shards));
  const remainder = total - shardSizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remainder; i++) shardSizes[i % shards]++;
  const bins: number[][] = Array.from({ length: shards }, () => []);
  let current = 0;
  atoms.forEach((_, index) => {
    const position = sizes[index] ? current : Math.max(current - 1, 0);
    let from = 0;
    for (let k = 0; k < shards; k++) {
      if (position >= from && position < from + shardSizes[k]) {
        bins[k].push(index);
        break;
      }
      from += shardSizes[k];
    }
    current += sizes[index];
  });
  return build('builtin', 'playwright', atoms, bins, workers, setup);
}

export function summary(plan: Plan) {
  return {
    strategy: plan.strategy,
    algorithm: plan.algorithm,
    sha: plan.sha,
    total_ms: plan.total_ms,
    makespan_ms: plan.makespan_ms,
    lower_bound_ms: plan.lower_bound_ms,
    largest: plan.largest,
    unknown_tests: plan.unknown_tests,
    shards: plan.shards.map(({ atoms, ...rest }) => rest),
  };
}

export function formatMs(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
