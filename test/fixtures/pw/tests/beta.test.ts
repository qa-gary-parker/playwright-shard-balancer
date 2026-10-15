import { expect, test } from '@playwright/test';
import { pause } from './pause';

test('beta', async () => {
  await pause(50);
  expect(process.env.FAIL_BETA ? 0 : 1).toBe(1);
});
