import { test } from '@playwright/test';
import { pause } from './pause';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(async () => {
  await pause(5);
});

for (const n of [1, 2, 3, 4]) {
  test(`epsilon ${n}`, async () => {
    await pause(60);
  });
}
