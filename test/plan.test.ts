import { describe, expect, it } from 'vitest';
import type { Atom } from '../src/atoms.js';
import { balance, builtin, formatMs } from '../src/plan.js';

const atom = (id: string, cost: number, deps: string[], order: number): Atom => ({
  id, project: deps.join('+') || 'none', file: `${id}.spec.ts`, keys: [id], cost, order, active: 1, unknown: 0, deps,
});

describe('balance with setup projects', () => {
  // Two projects with their own 10s setup. Mixing them makes a shard pay both setups.
  const atoms = [
    atom('a1', 30, ['setup-a'], 0), atom('a2', 30, ['setup-a'], 1),
    atom('b1', 30, ['setup-b'], 2), atom('b2', 30, ['setup-b'], 3),
  ];
  const setup = new Map([['setup-a', 10_000], ['setup-b', 10_000]]);
  const costly = atoms.map((a) => ({ ...a, cost: a.cost * 1000 }));

  it('gives each setup family its own shard when mixing would pay both setups', () => {
    const plan = balance(costly, 2, 1, setup);
    expect(plan.algorithm).toBe('setup-families');
    expect(plan.shards.map((s) => s.atoms.map((a) => a.id).sort())).toEqual([['a1', 'a2'], ['b1', 'b2']]);
    expect(plan.shards.map((s) => s.setup_ms)).toEqual([10_000, 10_000]);
    expect(plan.makespan_ms).toBe(70_000);
  });

  it('counts both setups on a shard that hosts both families', () => {
    const plan = builtin(costly, 1, 1, setup);
    expect(plan.shards[0].setup_ms).toBe(20_000);
    expect(plan.makespan_ms).toBe(140_000);
  });

  it('packs whole families when there are fewer shards than families', () => {
    const three = [...costly, atom('c1', 5_000, ['setup-c'], 4)];
    const plan = balance(three, 2, 1, new Map([...setup, ['setup-c', 10_000]]));
    for (const s of plan.shards) {
      const families = new Set(s.atoms.map((a) => a.deps[0]));
      expect(s.setup_ms).toBe(families.size * 10_000);
    }
    expect(plan.shards.flatMap((s) => s.atoms).length).toBe(5);
  });

  it('ignores families when no setup has a cost', () => {
    expect(balance(costly, 2, 1, new Map()).algorithm).not.toBe('setup-families');
  });
});

describe('builtin', () => {
  it('splits contiguous runs of groups by test count, the remainder to the first shards', () => {
    const atoms = ['a', 'b', 'c', 'd', 'e'].map((id, i) => atom(id, 1, [], i));
    expect(builtin(atoms, 2).shards.map((s) => s.atoms.map((a) => a.id))).toEqual([['a', 'b', 'c'], ['d', 'e']]);
  });
});

describe('formatMs', () => {
  it.each([
    [950, '0.9s'],
    [12_400, '12s'],
    [754_000, '12m34s'],
    [5_400_000, '1h30m'],
  ])('formats %i ms as %s', (ms, text) => {
    expect(formatMs(ms)).toBe(text);
  });
});
