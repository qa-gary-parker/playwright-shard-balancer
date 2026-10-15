import { describe, expect, it } from 'vitest';
import { atomsFromTests } from '../src/atoms.js';
import { createEstimator } from '../src/estimate.js';
import { builtin } from '../src/plan.js';
import { listedTests } from '../src/report.js';
import { emptyTimings } from '../src/timings.js';
import { membership, runFixture } from './helpers.js';

// The JSON list cannot show describe.configure modes or serial describes, so leave those out.
const GREP_INVERT = ['--grep-invert', 'delta serial|epsilon|gm '];

describe('builtin', () => {
  for (const fullyParallel of [false, true]) {
    for (const n of [2, 3, 4]) {
      it(`matches Playwright's own --shard split for ${n} shards, fullyParallel ${fullyParallel ? 'on' : 'off'}`, () => {
        const env = fullyParallel ? { FULLY_PARALLEL: '1' } : {};
        const tests = listedTests(runFixture(['--list', ...GREP_INVERT], env).report);
        const atoms = atomsFromTests(tests, createEstimator(emptyTimings()), fullyParallel ? 'test' : 'file');
        const plan = builtin(atoms, n);
        for (let k = 1; k <= n; k++) {
          const actual = membership(runFixture(['--list', ...GREP_INVERT, `--shard=${k}/${n}`], env).report);
          expect(plan.shards[k - 1].atoms.flatMap((a) => a.keys).sort()).toEqual(actual);
        }
      });
    }
  }
});
