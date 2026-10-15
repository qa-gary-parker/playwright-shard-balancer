import { test } from '@playwright/test';
import { pause } from './pause';

test('lock b', { lock: 'shared-account' }, async () => {
  await pause(200);
});
