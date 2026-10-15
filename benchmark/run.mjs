// Measures real Playwright runs: built-in --shard against the balancer, on generated suites
// with skewed file durations. Each shard's time is Playwright's own run duration.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist/cli.js');
const reporter = join(root, 'dist/reporter.js');
const SHARDS = [2, 4];
const WORKERS = [1, 2];

// A project with setup runs that setup on every shard that runs its tests.
const SUITES = [
  { name: 'one project', seed: 20261015, projects: [{ name: 'tests', files: 24, setupMs: 0 }] },
  {
    name: 'two projects with their own setup project (admin 4s, user 1.5s)',
    seed: 20261016,
    projects: [
      { name: 'admin', files: 6, setupMs: 4000 },
      { name: 'user', files: 18, setupMs: 1500 },
    ],
  },
];

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

for (const suite of SUITES) {
  // Inside the repo, so the generated config resolves @playwright/test.
  const dir = mkdtempSync(join(root, 'benchmark', '.suite-'));
  let seed = suite.seed;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  // Most files are short, a few are long: the shape that makes count-based shards uneven.
  let total = 0;
  const projects = [];
  for (const project of suite.projects) {
    mkdirSync(join(dir, project.name));
    for (let f = 0; f < project.files; f++) {
      const tests = 1 + Math.floor(random() * 6);
      const body = [`import { test } from '@playwright/test';`, ''];
      for (let t = 0; t < tests; t++) {
        const ms = Math.round(Math.exp(random() * 3.2) * 60);
        total += ms;
        body.push(`test('test ${t}', async () => { await new Promise((r) => setTimeout(r, ${ms})); });`);
      }
      writeFileSync(join(dir, project.name, `file-${String(f).padStart(2, '0')}.spec.ts`), `${body.join('\n')}\n`);
    }
    if (!project.setupMs) {
      projects.push({ name: project.name, testDir: project.name });
      continue;
    }
    const setup = `${project.name}-setup`;
    writeFileSync(
      join(dir, `${setup}.setup.ts`),
      `import { test } from '@playwright/test';\ntest('sign in', async () => { await new Promise((r) => setTimeout(r, ${project.setupMs})); });\n`,
    );
    projects.push({ name: setup, testDir: '.', testMatch: `${setup}.setup.ts` }, { name: project.name, testDir: project.name, dependencies: [setup] });
  }
  writeFileSync(
    join(dir, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
const reporters: any[] = [['json']];
if (process.env.BALANCE) reporters.push([${JSON.stringify(reporter)}, { timings: 'timings.json', record: process.env.RECORD, workers: Number(process.env.WORKERS ?? 1) }]);
export default defineConfig({ reporter: reporters, workers: Number(process.env.WORKERS ?? 1), projects: ${JSON.stringify(projects)} });
`,
  );

  const playwright = (args, env) =>
    new Promise((resolve, reject) => {
      const child = spawn('npx', ['playwright', 'test', '--config', join(dir, 'playwright.config.ts'), ...args], {
        cwd: root,
        env: { ...process.env, ...env },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error(`playwright gave no JSON: ${err}`));
        }
      });
    });

  // One full run teaches the timings.
  const full = await playwright([], { WORKERS: '4' });
  writeFileSync(join(dir, 'full.json'), JSON.stringify(full));
  spawnSync(process.execPath, [cli, 'update', '--timings', join(dir, 'timings.json'), join(dir, 'full.json')], { stdio: 'ignore' });

  const files = suite.projects.reduce((acc, p) => acc + p.files, 0);
  console.log(`Suite: ${suite.name}. ${files} files, ${(total / 1000).toFixed(1)}s of test time\n`);
  console.log('| Shards | Workers | Built-in slowest | Balanced slowest | Faster | Predicted | Even split of tests | Balanced spread |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const workers of WORKERS) {
    for (const n of SHARDS) {
      const shards = Array.from({ length: n }, (_, k) => `--shard=${k + 1}/${n}`);
      const records = shards.map((_, k) => join(dir, `run-${n}-${workers}-${k + 1}.json`));
      const env = { WORKERS: String(workers) };
      const builtin = await Promise.all(shards.map((s) => playwright([s], env)));
      const balanced = await Promise.all(shards.map((s, k) => playwright([s], { ...env, BALANCE: '1', RECORD: records[k] })));
      const slowest = (runs) => Math.max(...runs.map((r) => r.stats.duration));
      const spread = Math.max(...balanced.map((r) => r.stats.duration)) - Math.min(...balanced.map((r) => r.stats.duration));
      const b = slowest(builtin);
      const p = slowest(balanced);
      const predicted = Math.max(...JSON.parse(readFileSync(records[0], 'utf8')).predicted_ms);
      const check = spawnSync(process.execPath, [cli, 'check', ...records], { encoding: 'utf8' });
      if (check.status !== 0) throw new Error(`check failed: ${check.stderr}`);
      console.log(`| ${n} | ${workers} | ${seconds(b)} | ${seconds(p)} | ${Math.round((1 - p / b) * 100)}% | ${seconds(predicted)} | ${seconds(total / n / workers)} | ${seconds(spread)} |`);
    }
  }
  console.log('');
  rmSync(dir, { recursive: true, force: true });
}
console.log('Every balanced run passed `check`: each test ran exactly once.');
