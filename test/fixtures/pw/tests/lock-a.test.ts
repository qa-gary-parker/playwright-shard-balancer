import { test } from '@playwright/test';
import { pause } from './pause';

test('lock a', { lock: 'shared-account' }, async () => {
  await pause(200);
});
