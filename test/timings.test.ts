import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createEstimator } from '../src/estimate.js';
import { addSamples, emptyTimings, loadTimings, median, parseTimings, saveTimings, serializeTimings, type Timings } from '../src/timings.js';

const dir = mkdtempSync(join(tmpdir(), 'pwsb-timings-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const timings = (tests: Timings['tests']): Timings => ({ version: 1, tests });

describe('addSamples', () => {
  it('adds a sample per key and keeps the newest five', () => {
    let t = emptyTimings();
    for (const d of [10, 20, 30, 40, 50, 60]) t = addSamples(t, [{ key: 'k', durationMs: d }], '2026-10-15');
    expect(t.tests.k.samples).toEqual([20, 30, 40, 50, 60]);
  });

  it('rounds durations to whole milliseconds', () => {
    expect(addSamples(emptyTimings(), [{ key: 'k', durationMs: 12.6 }], '2026-10-15').tests.k.samples).toEqual([13]);
  });

  it('drops entries unseen for more than 30 days and keeps those seen within 30', () => {
    const t = timings({ old: { samples: [1], seen: '2026-09-14' }, recent: { samples: [1], seen: '2026-09-15' } });
    expect(Object.keys(addSamples(t, [], '2026-10-15').tests)).toEqual(['recent']);
  });

  it('marks a sampled entry as seen today', () => {
    const t = timings({ k: { samples: [1], seen: '2026-10-01' } });
    expect(addSamples(t, [{ key: 'k', durationMs: 2 }], '2026-10-15').tests.k).toEqual({ samples: [1, 2], seen: '2026-10-15' });
  });

  it('keeps the newest 200 merged-input shas', () => {
    const first = Array.from({ length: 150 }, (_, i) => `a${i}`);
    const second = Array.from({ length: 100 }, (_, i) => `b${i}`);
    const applied = addSamples(addSamples(emptyTimings(), [], '2026-10-15', first), [], '2026-10-15', second).applied!;
    expect(applied).toHaveLength(200);
    expect([applied[0], applied[199]]).toEqual(['a50', 'b99']);
  });

  it('does not change its input', () => {
    const t = timings({ k: { samples: [1], seen: '2026-10-15' } });
    addSamples(t, [{ key: 'k', durationMs: 2 }], '2026-10-15');
    expect(t.tests.k.samples).toEqual([1]);
  });
});

describe('parseTimings', () => {
  it.each([
    ['{', /is not valid JSON/],
    ['{"version":2,"tests":{}}', /unsupported version 2/],
    ['{"version":1}', /has no "tests" object/],
    ['{"version":1,"tests":{"k":{"samples":[],"seen":"2026-10-15"}}}', /invalid entry for "k"/],
    ['{"version":1,"tests":{"k":{"samples":[1.5],"seen":"2026-10-15"}}}', /invalid entry for "k"/],
    ['{"version":1,"tests":{"k":{"samples":[1]}}}', /invalid entry for "k"/],
  ])('rejects %s', (text, message) => {
    expect(() => parseTimings(text, 'timings.json')).toThrow(message);
  });
});

describe('saveTimings and loadTimings', () => {
  it('round-trips, and the same content always gives the same bytes and sha', () => {
    const a = timings({ b: { samples: [2], seen: '2026-10-15' }, a: { samples: [1], seen: '2026-10-15' } });
    const b = timings({ a: { samples: [1], seen: '2026-10-15' }, b: { samples: [2], seen: '2026-10-15' } });
    expect(serializeTimings(a)).toBe(serializeTimings(b));
    const file = join(dir, 't.json');
    const sha = saveTimings(file, a);
    expect(loadTimings(file)).toEqual({ timings: b, sha });
    expect(readFileSync(file, 'utf8')).toBe(serializeTimings(b));
  });

  it('creates the folder it saves into', () => {
    const file = join(dir, 'new', 'folder', 't.json');
    saveTimings(file, timings({}));
    expect(loadTimings(file).timings).toEqual(timings({}));
  });

  it('treats a missing file as empty timings with no sha', () => {
    expect(loadTimings(join(dir, 'missing.json'))).toEqual({ timings: emptyTimings(), sha: null });
  });

  it('throws on a corrupt file', () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, 'not json');
    expect(() => loadTimings(file)).toThrow(/is not valid JSON/);
  });
});

describe('median', () => {
  it('takes the middle sample, or the mean of the middle two', () => {
    expect(median([5, 1, 100])).toBe(5);
    expect(median([1, 2, 3, 100])).toBe(3);
  });
});

describe('createEstimator', () => {
  const estimator = createEstimator(
    timings({
      '[chromium] › a.spec.ts › one': { samples: [100, 900, 110], seen: '2026-10-15' },
      '[chromium] › a.spec.ts › two': { samples: [300], seen: '2026-10-15' },
      '[chromium] › b.spec.ts › one': { samples: [1000], seen: '2026-10-15' },
      '[firefox] › c.spec.ts › one': { samples: [5000], seen: '2026-10-15' },
    }),
  );
  const test = (project: string, file: string, title: string, staticSkip = false) => ({ key: `[${project}] › ${file} › ${title}`, project, file, staticSkip });

  it('uses the median of a known test, so one slow run does not move it', () => {
    expect(estimator.estimate(test('chromium', 'a.spec.ts', 'one'))).toBe(110);
  });

  it('estimates an unknown test from its file, then its project, then everything', () => {
    expect(estimator.estimate(test('chromium', 'a.spec.ts', 'new'))).toBe(205);
    expect(estimator.estimate(test('chromium', 'new.spec.ts', 'new'))).toBe(300);
    expect(estimator.estimate(test('webkit', 'new.spec.ts', 'new'))).toBe(650);
  });

  it('gives a test skipped before it runs no cost', () => {
    expect(estimator.estimate(test('chromium', 'a.spec.ts', 'one', true))).toBe(0);
  });

  it('counts known tests', () => {
    expect(estimator.knownCount).toBe(4);
    expect(estimator.isKnown('[chromium] › a.spec.ts › two')).toBe(true);
    expect(estimator.isKnown('[chromium] › a.spec.ts › new')).toBe(false);
  });
});
