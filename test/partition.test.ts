import { describe, expect, it } from 'vitest';
import { type Item, lowerBound, partition, wallTime } from '../src/partition.js';

function rng(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
}

const items = (costs: number[]): Item[] => costs.map((cost, order) => ({ cost, order }));
const sums = (p: { bins: number[][] }, list: Item[]) => p.bins.map((b) => b.reduce((acc, i) => acc + list[i].cost, 0));

function optimum(costs: number[], n: number): number {
  let best = Infinity;
  const loads = new Array<number>(n).fill(0);
  const sorted = [...costs].sort((a, b) => b - a);
  const rec = (i: number) => {
    if (i === sorted.length) return void (best = Math.min(best, Math.max(...loads)));
    for (let k = 0; k < n; k++) {
      if (loads[k] + sorted[i] >= best) continue;
      loads[k] += sorted[i];
      rec(i + 1);
      loads[k] -= sorted[i];
    }
  };
  rec(0);
  return best;
}

describe('partition', () => {
  it('assigns every item to exactly one shard', () => {
    const next = rng(1);
    for (let t = 0; t < 50; t++) {
      const list = items(Array.from({ length: 1 + Math.floor(next() * 60) }, () => Math.floor(next() * 5000)));
      const n = 1 + Math.floor(next() * 6);
      const p = partition(list, n);
      expect(p.bins).toHaveLength(n);
      expect(p.bins.flat().sort((a, b) => a - b)).toEqual([...list.keys()]);
    }
  });

  it('finds the optimum where largest-first does not', () => {
    // Largest-first gives 17/13; the optimum is 8+7 and 6+5+4.
    const p = partition(items([8, 7, 6, 5, 4]), 2);
    expect(p.makespan).toBe(15);
    expect(sums(p, items([8, 7, 6, 5, 4])).sort()).toEqual([15, 15]);
  });

  it('matches a brute-force optimum on random small suites', () => {
    const next = rng(42);
    for (let t = 0; t < 120; t++) {
      const costs = Array.from({ length: 6 + Math.floor(next() * 7) }, () => 1 + Math.floor(next() * 90_000));
      const n = 2 + Math.floor(next() * 3);
      expect(partition(items(costs), n).makespan).toBe(optimum(costs, n));
    }
  });

  it('gives the same shards for the same items in any input order', () => {
    const next = rng(9);
    const list = items(Array.from({ length: 300 }, () => Math.floor(next() * 10_000)));
    const shuffled = [...list].sort(() => next() - 0.5);
    const byOrder = (p: { bins: number[][] }, l: Item[]) => p.bins.map((b) => b.map((i) => l[i].order).sort((a, c) => a - c));
    expect(byOrder(partition(shuffled, 5), shuffled)).toEqual(byOrder(partition(list, 5), list));
  });

  it('gives the same shards on every call when costs tie', () => {
    const next = rng(21);
    for (let t = 0; t < 300; t++) {
      const list = items(Array.from({ length: 6 + Math.floor(next() * 40) }, () => 1 + Math.floor(next() * 30)));
      const n = 2 + Math.floor(next() * 5);
      expect(JSON.stringify(partition(list, n).bins)).toBe(JSON.stringify(partition(list, n).bins));
    }
  });

  it('reaches the lower bound when the items split evenly', () => {
    const list = items([5, 5, 5, 5, 5, 5, 5, 5]);
    const p = partition(list, 4);
    expect(p.lowerBound).toBe(10);
    expect(p.makespan).toBe(10);
  });

  it('cannot beat the largest item', () => {
    const p = partition(items([100, 1, 1, 1]), 3);
    expect(p.makespan).toBe(100);
    expect(p.lowerBound).toBe(100);
  });

  it('leaves extra shards empty when there are fewer items than shards', () => {
    const p = partition(items([3, 2]), 4);
    expect(p.bins.filter((b) => b.length === 0)).toHaveLength(2);
    expect(p.makespan).toBe(3);
  });

  it('handles no items', () => {
    const p = partition([], 3);
    expect(p.bins).toEqual([[], [], []]);
    expect(p.makespan).toBe(0);
  });

  it('rejects a shard count that is not a positive integer', () => {
    expect(() => partition(items([1]), 0)).toThrow('shard count must be a positive integer, got 0');
  });

  it('with several workers, packs each shard for wall time and is never worse than balancing sums', () => {
    const next = rng(5);
    let better = 0;
    for (let t = 0; t < 200; t++) {
      const list = items(Array.from({ length: 5 + Math.floor(next() * 8) }, () => 1 + Math.floor(next() * 20)));
      const sumOnly = partition(list, 2, 1);
      const sumOnlyWall = Math.max(...sumOnly.bins.map((b) => wallTime(list, b, 2)));
      const aware = partition(list, 2, 2);
      expect(aware.makespan).toBeLessThanOrEqual(sumOnlyWall);
      if (aware.makespan < sumOnlyWall) better++;
    }
    expect(better).toBeGreaterThan(20);
  });

  it('splits 10,000 items into 32 shards in under 3 seconds, at the lower bound', () => {
    const next = rng(3);
    const list = items(Array.from({ length: 10_000 }, () => Math.round(Math.exp(next() * 6) * 300)));
    const started = performance.now();
    const p = partition(list, 32);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(p.makespan).toBe(p.lowerBound);
  });

  it('searches a suite of thousands of equal-cost groups without running out of stack', () => {
    // 6,001 groups of 7 ms cannot reach the even-split bound, so the search runs its full budget.
    const list = items(Array.from({ length: 6001 }, () => 7));
    const p = partition(list, 4);
    expect(p.bins.flat().sort((a, b) => a - b)).toEqual([...list.keys()]);
    expect(p.makespan).toBe(1501 * 7);
  });

  it('finds the optimum when many groups cost nothing', () => {
    // Statically skipped tests cost 0; they must not use up the search before it reaches the optimum.
    const costs = [1900, 4421, 0, 3440, 3515, 1403, 1508, 4535, 0, 4647, 2452, 0, 1719, 0, 0, 0, 0, 484, 2123, 1964, 0, 1476, 3236, 3122, 2640, 4700, 0, 3786,
      4103, 0, 0, 3629, 0, 0, 666, 519, 1455, 0, 0, 3822];
    expect(partition(items(costs), 4).makespan).toBe(16822);
  });
});

describe('wallTime', () => {
  it('is the sum with one worker', () => {
    expect(wallTime(items([3, 4, 5]), [0, 1, 2], 1)).toBe(12);
  });

  it('gives each item to the first free worker, in load order', () => {
    // Workers take 1 then 2; 3 goes to the worker that freed first (after 1), and 9 to the next.
    expect(wallTime(items([1, 2, 3, 9]), [3, 2, 1, 0], 2)).toBe(11);
  });
});

describe('lowerBound', () => {
  it('is the larger of an even split across all workers and the largest item', () => {
    expect(lowerBound(items([10, 10, 10, 10]), 2, 1)).toBe(20);
    expect(lowerBound(items([10, 10, 10, 10]), 2, 2)).toBe(10);
    expect(lowerBound(items([30, 1, 1]), 2, 1)).toBe(30);
  });
});
