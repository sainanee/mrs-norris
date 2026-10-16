import { isTestFile } from '../../src/metrics/classify.js';

test.each([
  ['__tests__/x.ts', true],
  ['x.spec.tsx', true],
  ['tests/x.ts', true],
  ['src/x.ts', false],
])('isTestFile(%s) is %s', (file, expected) => {
  expect(isTestFile(file)).toBe(expected);
});
