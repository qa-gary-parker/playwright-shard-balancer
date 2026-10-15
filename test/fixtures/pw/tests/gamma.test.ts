import { test } from '@playwright/test';
import { pause } from './pause';

for (const n of [1, 2, 3, 4]) {
  test(`gamma ${n}`, async () => {
    await pause(20);
  });
}
