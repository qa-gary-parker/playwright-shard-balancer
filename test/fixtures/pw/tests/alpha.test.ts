import { test } from '@playwright/test';
import { pause } from './pause';

test.describe('alpha', () => {
  test('one', async () => {
    await pause(300);
  });
  test('two', async () => {
    await pause(300);
  });
  test('three', async () => {
    await pause(300);
  });
});
