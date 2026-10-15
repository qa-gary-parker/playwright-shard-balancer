// Measures real Playwright runs: built-in --shard against the balancer, on a generated suite
// with skewed file durations. Each shard's time is Playwright's own run duration.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist/cli.js');
const reporter = join(root, 'dist/reporter.js');
// Inside the repo, so the generated config resolves @playwright/test.
const dir = mkdtempSync(join(root, 'benchmark', '.suite-'));
const FILES = 24;
const SHARDS = [2, 4];
const WORKERS = [1, 2];

let seed = 20261015;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// Most files are short, a few are long: the shape that makes count-based shards uneven.
mkdirSync(join(dir, 'tests'));
let total = 0;
for (let f = 0; f < FILES; f++) {
  const tests = 1 + Math.floor(random() * 6);
  const body = [`import { test } from '@playwright/test';`, ''];
  for (let t = 0; t < tests; t++) {
    const ms = Math.round(Math.exp(random() * 3.2) * 60);
    total += ms;
    body.push(`test('test ${t}', async () => { await new Promise((r) => setTimeout(r, ${ms})); });`);
  }
  writeFileSync(join(dir, 'tests', `file-${String(f).padStart(2, '0')}.spec.ts`), `${body.join('\n')}\n`);
}
writeFileSync(
  join(dir, 'playwright.config.ts'),
  `import { defineConfig } from '@playwright/test';
const reporters: any[] = [['json']];
if (process.env.BALANCE) reporters.push([${JSON.stringify(reporter)}, { timings: 'timings.json', record: process.env.RECORD, workers: Number(process.env.WORKERS ?? 1) }]);
export default defineConfig({ testDir: 'tests', reporter: reporters, workers: Number(process.env.WORKERS ?? 1) });
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

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

// One full run teaches the timings.
const full = await playwright([], { WORKERS: '4' });
writeFileSync(join(dir, 'full.json'), JSON.stringify(full));
spawnSync(process.execPath, [cli, 'update', '--timings', join(dir, 'timings.json'), join(dir, 'full.json')], { stdio: 'ignore' });

console.log(`Suite: ${FILES} files, ${(total / 1000).toFixed(1)}s of test time\n`);
console.log('| Shards | Workers | Built-in slowest | Balanced slowest | Faster | Even split | Balanced spread |');
console.log('|---|---|---|---|---|---|---|');
for (const workers of WORKERS) {
  for (const n of SHARDS) {
    const shards = Array.from({ length: n }, (_, k) => `--shard=${k + 1}/${n}`);
    const env = { WORKERS: String(workers) };
    const builtin = await Promise.all(shards.map((s) => playwright([s], env)));
    const balanced = await Promise.all(shards.map((s, k) => playwright([s], { ...env, BALANCE: '1', RECORD: join(dir, `run-${n}-${workers}-${k + 1}.json`) })));
    const slowest = (runs) => Math.max(...runs.map((r) => r.stats.duration));
    const spread = Math.max(...balanced.map((r) => r.stats.duration)) - Math.min(...balanced.map((r) => r.stats.duration));
    const b = slowest(builtin);
    const p = slowest(balanced);
    const check = spawnSync(process.execPath, [cli, 'check', ...Array.from({ length: n }, (_, k) => join(dir, `run-${n}-${workers}-${k + 1}.json`))], { encoding: 'utf8' });
    if (check.status !== 0) throw new Error(`check failed: ${check.stderr}`);
    console.log(`| ${n} | ${workers} | ${seconds(b)} | ${seconds(p)} | ${Math.round((1 - p / b) * 100)}% | ${seconds(total / n / workers)} | ${seconds(spread)} |`);
  }
}
console.log('\nEvery balanced run passed `check`: each test ran exactly once.');
rmSync(dir, { recursive: true, force: true });
