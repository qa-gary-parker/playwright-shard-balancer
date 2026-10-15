import { test } from '@playwright/test';
import { pause } from './pause';

test('zeta slow', async () => {
  await pause(400);
});

test.skip('zeta skipped', async () => {
  await pause(400);
});

test.describe(() => {
  test('zeta anonymous', async () => {
    await pause(30);
  });
});
