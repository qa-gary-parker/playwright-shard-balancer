import { test } from '@playwright/test';
import { pause } from './pause';

test.describe.serial('delta serial', () => {
  test('first', async () => {
    await pause(100);
  });
  test('second', async () => {
    await pause(100);
  });
  test('third', async () => {
    await pause(100);
  });
});

test('delta alone', async () => {
  await pause(10);
});
