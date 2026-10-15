import type { Estimator } from './estimate.js';
import { type ReportTest, testKey } from './report.js';

// An atom is the unit that goes to one shard: a set of tests that must run together.
export type Atom = {
  id: string;
  project: string;
  file: string;
  keys: string[];
  cost: number;
  order: number;
  // Tests not skipped before they run: what Playwright's own sharding counts.
  active: number;
  unknown: number;
  // Setup and teardown projects the atom's tests need, sorted.
  deps: string[];
};

export type Granularity = 'file' | 'test';

export const repeatSuffix = (r: number) => (r > 0 ? ` (repeat ${r})` : '');

type AtomTest = { key: string; project: string; file: string; staticSkip: boolean };

export function addToAtom(atoms: Map<string, Atom>, id: string, test: AtomTest, cost: number, known: boolean, deps: string[] = []): Atom {
  let atom = atoms.get(id);
  if (!atom) atoms.set(id, (atom = { id, project: test.project, file: test.file, keys: [], cost: 0, order: atoms.size, active: 0, unknown: 0, deps }));
  atom.keys.push(test.key);
  atom.cost += cost;
  if (!test.staticSkip) atom.active++;
  if (!known) atom.unknown++;
  return atom;
}

// From a --list report. "test" splits tests apart but keeps each serial describe together; the
// report cannot show describe.configure({ mode: 'default' }) inside a parallel file.
export function atomsFromTests(tests: ReportTest[], estimator: Estimator, granularity: Granularity, deps = new Map<string, string[]>()): Atom[] {
  const atoms = new Map<string, Atom>();
  const seen = new Map<string, number>();
  for (const test of tests) {
    const repeat = seen.get(test.key) ?? 0;
    seen.set(test.key, repeat + 1);
    const fileId = testKey(test.project, test.file, []);
    const base = granularity === 'file' ? fileId : test.serial ? `${fileId} › serial@${test.serial}` : test.key;
    const known = test.staticSkip || estimator.isKnown(test.key);
    addToAtom(atoms, base + repeatSuffix(repeat), test, estimator.estimate(test), known, deps.get(test.project) ?? []);
  }
  return [...atoms.values()];
}

// Tests that share a Playwright lock must not run at the same time. Shards run at the same time,
// so atoms that share a lock merge into one and go to the same shard.
export function mergeLocked(atoms: Atom[], locks: Map<string, string[]>): { atoms: Atom[]; members: Map<string, string[]> } {
  const parent = atoms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<string, number>();
  atoms.forEach((atom, i) => {
    for (const lock of locks.get(atom.id) ?? []) {
      const j = owner.get(lock);
      if (j === undefined) owner.set(lock, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, number[]>();
  atoms.forEach((_, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(i));
  const members = new Map<string, string[]>();
  const merged = [...groups.values()].map((group) => {
    const list = group.map((i) => atoms[i]);
    const first = list[0];
    const id = list.length === 1 ? first.id : `${first.id} + ${list.length - 1} locked`;
    members.set(id, list.map((a) => a.id));
    return {
      ...first,
      id,
      keys: list.flatMap((a) => a.keys),
      cost: list.reduce((acc, a) => acc + a.cost, 0),
      order: Math.min(...list.map((a) => a.order)),
      active: list.reduce((acc, a) => acc + a.active, 0),
      unknown: list.reduce((acc, a) => acc + a.unknown, 0),
      deps: [...new Set(list.flatMap((a) => a.deps))].sort(),
    };
  });
  merged.sort((a, b) => a.order - b.order);
  return { atoms: merged, members };
}
