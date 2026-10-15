import { describe, expect, it } from 'vitest';
import { type Atom, mergeLocked } from '../src/atoms.js';
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
    expect(plan.algorithm).toBe('setup-families');
    expect(plan.shards.map((s) => s.atoms.map((a) => a.id))).toEqual([['a1', 'a2', 'c1'], ['b1', 'b2']]);
  });

  it('weighs setup against work atom by atom when neither split by sum nor by family is best', () => {
    // By sum, 7 | 3+3+1 is even, but the second shard also pays the 2s setup: 9s. By family,
    // 3 | 7+3+1 is 11s. Placing each atom where it ends soonest gives 7+1 | 3+3 plus setup: 8s.
    const mixed = [atom('slow', 7_000, [], 0), atom('needs', 3_000, ['setup'], 1), atom('mid', 3_000, [], 2), atom('quick', 1_000, [], 3)];
    const plan = balance(mixed, 2, 1, new Map([['setup', 2_000]]));
    expect(plan.algorithm).toBe('setup-greedy');
    expect(plan.shards.map((s) => s.atoms.map((a) => a.id))).toEqual([['slow', 'quick'], ['needs', 'mid']]);
    expect(plan.makespan_ms).toBe(8_000);
  });

  it('counts setup in the lower bound', () => {
    // Twelve 10s groups on 3 shards need 40s each, and every shard also runs the 30s setup.
    const atoms = Array.from({ length: 12 }, (_, i) => atom(`t${i}`, 10_000, ['setup'], i));
    const plan = balance(atoms, 3, 1, new Map([['setup', 30_000]]));
    expect(plan.lower_bound_ms).toBe(70_000);
    expect(plan.makespan_ms).toBe(70_000);
  });
});

describe('mergeLocked', () => {
  it('joins groups that share a lock through another group', () => {
    // A and B share x, B and C share y: all three must go to one shard.
    const atoms = [atom('A', 1, [], 0), atom('C', 1, [], 1), atom('B', 1, [], 2)];
    const merged = mergeLocked(atoms, new Map([['A', ['x']], ['C', ['y']], ['B', ['x', 'y']]]));
    expect(merged.atoms.map((a) => a.id)).toEqual(['A + 2 locked']);
    expect(merged.members.get('A + 2 locked')).toEqual(['A', 'C', 'B']);
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
