import { median, type Timings } from './timings.js';

export type EstimateInput = { key: string; project: string; file: string; staticSkip: boolean };
export type Estimator = {
  estimate: (test: EstimateInput) => number;
  isKnown: (key: string) => boolean;
  knownCount: number;
};

const SEP = ' › ';

// "[project] › file › ..." gives the project and the file scope "[project] › file".
function scope(key: string): { project: string; fileScope: string } | null {
  const parts = key.split(SEP);
  if (parts.length < 2 || !parts[0].startsWith('[') || !parts[0].endsWith(']')) return null;
  return { project: parts[0].slice(1, -1), fileScope: `${parts[0]}${SEP}${parts[1]}` };
}

// A known test costs the median of its samples. An unknown test costs the median of the known
// tests in its describe, else its file, else its project, else the whole timings file. A test
// skipped before it runs costs nothing.
export function createEstimator(timings: Timings): Estimator {
  const known = new Map<string, number>();
  const byParent = new Map<string, number[]>();
  const byFile = new Map<string, number[]>();
  const byProject = new Map<string, number[]>();
  const all: number[] = [];
  for (const [key, entry] of Object.entries(timings.tests)) {
    const value = median(entry.samples);
    known.set(key, value);
    all.push(value);
    const s = scope(key);
    if (!s) continue;
    const parent = key.slice(0, key.lastIndexOf(SEP));
    if (parent !== s.fileScope) (byParent.get(parent) ?? byParent.set(parent, []).get(parent)!).push(value);
    (byFile.get(s.fileScope) ?? byFile.set(s.fileScope, []).get(s.fileScope)!).push(value);
    (byProject.get(s.project) ?? byProject.set(s.project, []).get(s.project)!).push(value);
  }
  const cache = new Map<string, number>();
  const groupMedian = (id: string, values: number[] | undefined): number | undefined => {
    if (!values?.length) return undefined;
    let m = cache.get(id);
    if (m === undefined) cache.set(id, (m = median(values)));
    return m;
  };
  const globalMedian = all.length ? median(all) : 1;

  return {
    knownCount: known.size,
    isKnown: (key) => known.has(key),
    estimate: (test) => {
      if (test.staticSkip) return 0;
      const value = known.get(test.key);
      if (value !== undefined) return value;
      const fileScope = `[${test.project}]${SEP}${test.file}`;
      const parent = test.key.slice(0, test.key.lastIndexOf(SEP));
      return (parent !== fileScope ? groupMedian(`d:${parent}`, byParent.get(parent)) : undefined) ??
        groupMedian(`f:${fileScope}`, byFile.get(fileScope)) ?? groupMedian(`p:${test.project}`, byProject.get(test.project)) ?? globalMedian;
    },
  };
}
