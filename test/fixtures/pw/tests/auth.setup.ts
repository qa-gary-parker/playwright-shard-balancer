import { test } from '@playwright/test';
import { pause } from './pause';

test('authenticate', async () => {
  await pause(10);
});
