import { test } from '@playwright/test';
import { pause } from './pause';

// Defines the same tests in every spec that calls it.
export function sharedSuite() {
  test.describe('shared suite', () => {
    test('works', async () => {
      await pause(40);
    });
  });
}
