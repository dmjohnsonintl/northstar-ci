import { expect, test } from 'vitest';
import { sum } from './sum.js';

test('sum adds two numbers', () => {
  expect(sum(2, 3)).toBe(5);
});
