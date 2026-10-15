import { test } from '@playwright/test';
import { pause } from './pause';

// Groups inside a parallel file that must each stay on one shard.
test.describe.configure({ mode: 'parallel' });

test.describe('gm default', () => {
  test.describe.configure({ mode: 'default' });
  test('d1', async () => {
    await pause(1);
  });
  test('d2', async () => {
    await pause(1);
  });
});

test.describe.serial('gm outer', () => {
  test('o1', async () => {
    await pause(1);
  });
  test.describe.serial('gm inner', () => {
    test('i1', async () => {
      await pause(1);
    });
  });
});

test.describe(() => {
  test.describe.configure({ mode: 'serial' });
  test('gm anonymous x1', async () => {
    await pause(1);
  });
  test('gm anonymous x2', async () => {
    await pause(1);
  });
});

test.describe(() => {
  test.describe.configure({ mode: 'serial' });
  test('gm anonymous y1', async () => {
    await pause(1);
  });
  test('gm anonymous y2', async () => {
    await pause(1);
  });
});
