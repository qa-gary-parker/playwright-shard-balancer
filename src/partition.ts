// Splits weighted items into n shards so the slowest shard finishes as early as possible.
// Everything here is deterministic: the same items, n and workers give the same shards on
// every machine, which is what lets each shard compute the plan on its own.

export type Item = {
  cost: number;
  // Position in Playwright's load order. Workers in a shard take items in this order.
  order: number;
};

export type Partition = {
  bins: number[][];
  sums: number[];
  // Estimated wall time of each shard with `workers` workers.
  walls: number[];
  makespan: number;
  lowerBound: number;
  algorithm: string;
};

const SUM_ITERATIONS = 20_000;
// Branch-and-bound visits at most this many nodes. A node count, not a clock, keeps it deterministic.
const SEARCH_NODES = 400_000;
const WALL_ITERATIONS = 200;
const WALL_CANDIDATES = 48;
const WALL_TARGETS = 4;

// Wall time of one shard: its items go to the first free worker, in load order.
export function wallTime(items: Item[], bin: number[], workers: number): number {
  let sum = 0;
  for (const i of bin) sum += items[i].cost;
  if (workers <= 1 || bin.length <= 1) return sum;
  const free = new Array<number>(Math.min(workers, bin.length)).fill(0);
  const ordered = [...bin].sort((a, b) => items[a].order - items[b].order || a - b);
  for (const i of ordered) {
    let w = 0;
    for (let k = 1; k < free.length; k++) if (free[k] < free[w]) w = k;
    free[w] += items[i].cost;
  }
  return Math.max(...free);
}

export function lowerBound(items: Item[], n: number, workers: number): number {
  let total = 0;
  let largest = 0;
  for (const item of items) {
    total += item.cost;
    largest = Math.max(largest, item.cost);
  }
  return Math.max(Math.ceil(total / (n * Math.max(1, workers))), largest);
}

// Largest first, each to the least-loaded shard.
function lpt(items: Item[], n: number, sorted: number[]): number[][] {
  const bins: number[][] = Array.from({ length: n }, () => []);
  const sums = new Array<number>(n).fill(0);
  for (const i of sorted) {
    let best = 0;
    for (let s = 1; s < n; s++) if (sums[s] < sums[best]) best = s;
    bins[best].push(i);
    sums[best] += items[i].cost;
  }
  return bins;
}

type Rope = { items?: number[]; parts?: [Rope, Rope] };
type Partial = { sums: number[]; sets: Rope[]; seq: number };

function flatten(rope: Rope, out: number[]): number[] {
  const stack: Rope[] = [rope];
  while (stack.length) {
    const r = stack.pop()!;
    if (r.items) out.push(...r.items);
    if (r.parts) stack.push(r.parts[1], r.parts[0]);
  }
  return out;
}

class Heap<T> {
  private data: T[] = [];
  constructor(private before: (a: T, b: T) => boolean) {}
  get size() {
    return this.data.length;
  }
  push(value: T) {
    const d = this.data;
    d.push(value);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.before(d[i], d[p])) break;
      [d[i], d[p]] = [d[p], d[i]];
      i = p;
    }
  }
  pop(): T {
    const d = this.data;
    const top = d[0];
    const last = d.pop()!;
    if (d.length) {
      d[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && this.before(d[l], d[m])) m = l;
        if (r < d.length && this.before(d[r], d[m])) m = r;
        if (m === i) break;
        [d[i], d[m]] = [d[m], d[i]];
        i = m;
      }
    }
    return top;
  }
}

// Karmarkar-Karp largest differencing for n shards: repeatedly merge the two partial
// solutions with the largest spread, pairing the heaviest set of one with the lightest of the other.
function karmarkarKarp(items: Item[], n: number, sorted: number[]): number[][] {
  let seq = 0;
  const spread = (p: Partial) => p.sums[0] - p.sums[n - 1];
  const heap = new Heap<Partial>((a, b) => spread(a) > spread(b) || (spread(a) === spread(b) && a.seq < b.seq));
  for (const i of sorted) {
    const sums = new Array<number>(n).fill(0);
    sums[0] = items[i].cost;
    const sets: Rope[] = Array.from({ length: n }, (_, k) => ({ items: k === 0 ? [i] : [] }));
    heap.push({ sums, sets, seq: seq++ });
  }
  if (heap.size === 0) return Array.from({ length: n }, () => []);
  while (heap.size > 1) {
    const a = heap.pop();
    const b = heap.pop();
    const merged = Array.from({ length: n }, (_, k) => ({
      sum: a.sums[k] + b.sums[n - 1 - k],
      set: { parts: [a.sets[k], b.sets[n - 1 - k]] } as Rope,
      k,
    }));
    merged.sort((x, y) => y.sum - x.sum || x.k - y.k);
    heap.push({ sums: merged.map((m) => m.sum), sets: merged.map((m) => m.set), seq: seq++ });
  }
  return heap.pop().sets.map((set) => flatten(set, []));
}

// Complete greedy search: items largest first, each tried in every shard (least loaded first,
// one shard per distinct load), pruned by the best makespan found so far and by the even-split
// bound. Proves the optimum for small and medium suites; stops at SEARCH_NODES on large ones.
function search(items: Item[], n: number, sorted: number[], incumbent: number): number[][] | null {
  const m = sorted.length;
  const cost = sorted.map((i) => items[i].cost);
  const remaining = new Array<number>(m + 1).fill(0);
  for (let k = m - 1; k >= 0; k--) remaining[k] = remaining[k + 1] + cost[k];
  const total = remaining[0];
  const floor = Math.max(Math.ceil(total / n), cost[0] ?? 0);
  if (incumbent <= floor) return null;
  const loads = new Array<number>(n).fill(0);
  const assign = new Array<number>(m).fill(0);
  let best = incumbent;
  let bestAssign: number[] | null = null;
  let nodes = 0;
  const visit = (k: number, maxLoad: number): boolean => {
    if (++nodes > SEARCH_NODES) return true;
    if (k === m) {
      best = maxLoad;
      bestAssign = [...assign];
      return best <= floor;
    }
    const order = [...loads.keys()].sort((a, b) => loads[a] - loads[b] || a - b);
    let last = -1;
    for (const s of order) {
      if (loads[s] === last) continue;
      last = loads[s];
      if (loads[s] + cost[k] >= best) break;
      loads[s] += cost[k];
      assign[k] = s;
      const stop = visit(k + 1, Math.max(maxLoad, loads[s]));
      loads[s] -= cost[k];
      if (stop) return true;
    }
    return false;
  };
  visit(0, 0);
  if (!bestAssign) return null;
  const bins: number[][] = Array.from({ length: n }, () => []);
  (bestAssign as number[]).forEach((s, k) => bins[s].push(sorted[k]));
  return bins;
}

// Moves and swaps between the heaviest shard and the others. Each accepted step moves an
// amount d with 0 < d < gap, which lowers the sum of squares and never raises the maximum.
function refineSums(items: Item[], bins: number[][]): number[][] {
  const n = bins.length;
  const cost = (i: number) => items[i].cost;
  const byCost = (a: number, b: number) => cost(a) - cost(b) || a - b;
  const sorted = bins.map((b) => [...b].sort(byCost));
  const sums = sorted.map((b) => b.reduce((acc, i) => acc + cost(i), 0));

  for (let iter = 0; iter < SUM_ITERATIONS; iter++) {
    let s = 0;
    for (let k = 1; k < n; k++) if (sums[k] > sums[s]) s = k;
    let best = { score: 0, t: -1, a: -1, b: -1 };
    for (let t = 0; t < n; t++) {
      const gap = sums[s] - sums[t];
      if (t === s || gap <= 1) continue;
      const src = sorted[s];
      const dst = sorted[t];
      let j = 0;
      for (const a of src) {
        const ca = cost(a);
        if (ca <= 0) continue;
        if (ca < gap) {
          const score = ca * (gap - ca);
          if (score > best.score) best = { score, t, a, b: -1 };
        }
        // Swap partner b with ca - cb closest to gap / 2; targets rise with ca, so j only moves forward.
        const target = ca - gap / 2;
        while (j < dst.length && cost(dst[j]) < target) j++;
        for (const k of [j - 1, j]) {
          if (k < 0 || k >= dst.length) continue;
          const d = ca - cost(dst[k]);
          if (d <= 0 || d >= gap) continue;
          const score = d * (gap - d);
          if (score > best.score) best = { score, t, a, b: dst[k] };
        }
      }
    }
    if (best.t === -1) break;
    const remove = (arr: number[], i: number) => arr.splice(arr.indexOf(i), 1);
    const insert = (arr: number[], i: number) => {
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (byCost(arr[mid], i) < 0) lo = mid + 1;
        else hi = mid;
      }
      arr.splice(lo, 0, i);
    };
    remove(sorted[s], best.a);
    insert(sorted[best.t], best.a);
    sums[s] -= cost(best.a);
    sums[best.t] += cost(best.a);
    if (best.b !== -1) {
      remove(sorted[best.t], best.b);
      insert(sorted[s], best.b);
      sums[best.t] -= cost(best.b);
      sums[s] += cost(best.b);
    }
  }
  return sorted;
}

// With several workers per shard, a shard's wall time also depends on how its items pack onto
// workers. Moves the heaviest items off the slowest shard while that lowers the slowest wall time.
function refineWalls(items: Item[], bins: number[][], workers: number): number[][] {
  const n = bins.length;
  const result = bins.map((b) => [...b]);
  const walls = result.map((b) => wallTime(items, b, workers));
  for (let iter = 0; iter < WALL_ITERATIONS; iter++) {
    let s = 0;
    for (let k = 1; k < n; k++) if (walls[k] > walls[s]) s = k;
    const targets = [...walls.keys()]
      .filter((t) => t !== s)
      .sort((a, b) => walls[a] - walls[b] || a - b)
      .slice(0, WALL_TARGETS);
    const candidates = [...result[s]].sort((a, b) => items[b].cost - items[a].cost || a - b).slice(0, WALL_CANDIDATES);
    let best: { t: number; a: number; ws: number; wt: number; max: number; sq: number } | null = null;
    for (const a of candidates) {
      const ws = wallTime(items, result[s].filter((i) => i !== a), workers);
      for (const t of targets) {
        const wt = wallTime(items, [...result[t], a], workers);
        const max = Math.max(ws, wt);
        const sq = ws * ws + wt * wt;
        if (max >= walls[s]) continue;
        if (!best || max < best.max || (max === best.max && sq < best.sq)) best = { t, a, ws, wt, max, sq };
      }
    }
    if (!best) break;
    const { t, a } = best;
    result[s] = result[s].filter((i) => i !== a);
    result[t].push(a);
    walls[s] = best.ws;
    walls[t] = best.wt;
  }
  return result;
}

function evaluate(items: Item[], bins: number[][], workers: number, algorithm: string, bound: number): Partition {
  const ordered = bins.map((b) => [...b].sort((a, c) => items[a].order - items[c].order || a - c));
  const sums = ordered.map((b) => b.reduce((acc, i) => acc + items[i].cost, 0));
  const walls = ordered.map((b) => wallTime(items, b, workers));
  return { bins: ordered, sums, walls, makespan: Math.max(0, ...walls), lowerBound: bound, algorithm };
}

const spreadScore = (p: Partition) => p.walls.reduce((acc, w) => acc + w * w, 0);

export function partition(items: Item[], n: number, workers = 1): Partition {
  if (!Number.isInteger(n) || n < 1) throw new Error(`shard count must be a positive integer, got ${n}`);
  const w = Math.max(1, Math.floor(workers));
  const bound = lowerBound(items, n, w);
  const sorted = [...items.keys()].sort((a, b) => items[b].cost - items[a].cost || items[a].order - items[b].order || a - b);

  const sumMax = (bins: number[][]) => Math.max(0, ...bins.map((b) => b.reduce((acc, i) => acc + items[i].cost, 0)));
  const splits: [string, number[][]][] = [
    ['lpt+refine', refineSums(items, lpt(items, n, sorted))],
    ['kk+refine', refineSums(items, karmarkarKarp(items, n, sorted))],
  ];
  const exact = search(items, n, sorted, Math.min(...splits.map(([, bins]) => sumMax(bins))));
  if (exact) splits.push(['search', exact]);

  const candidates: Partition[] = splits.map(([name, bins]) =>
    w > 1 ? evaluate(items, refineWalls(items, bins, w), w, `${name}+workers`, bound) : evaluate(items, bins, w, name, bound),
  );
  candidates.sort((a, b) => a.makespan - b.makespan || spreadScore(a) - spreadScore(b));
  return candidates[0];
}
