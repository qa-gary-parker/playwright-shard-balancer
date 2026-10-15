import { defineConfig, type ReporterDescription } from '@playwright/test';

// The tests pass the built reporter's path, its options and the run shape through env.
const reporters: ReporterDescription[] = [['json']];
if (process.env.PWSB_REPORTER) reporters.push([process.env.PWSB_REPORTER, JSON.parse(process.env.PWSB_OPTIONS ?? '{}')]);

export default defineConfig({
  testDir: 'tests',
  reporter: reporters,
  fullyParallel: process.env.FULLY_PARALLEL === '1',
  workers: Number(process.env.WORKERS ?? 1),
  retries: 0,
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    { name: 'chromium', dependencies: ['setup'], testIgnore: /.*\.setup\.ts/ },
  ],
});
