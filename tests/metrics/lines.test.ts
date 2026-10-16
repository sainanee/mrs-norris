import { countLines } from '../../src/metrics/lines.js';

test('classifies each line as code, comment or blank', () => {
  const source = ['// a', '/* b', '   c */', 'const x = 1; // trailing', '', '// d', 'export { x };', ''].join('\n');
  expect(countLines(source, 'a.ts')).toEqual({ code: 2, comment: 4, blank: 1 });
});

test.each([
  ['a template literal after an interpolation', 'const u = `${base}//host`;\n', 'a.ts'],
  ['JSX text that looks like a comment', 'const e = (\n  <a>\n    http://x\n  </a>\n);\n', 'a.tsx'],
])('does not mistake %s for a comment', (_, source, fileName) => {
  expect(countLines(source, fileName).comment).toBe(0);
});

test('counts JSDoc blocks as comments', () => {
  expect(countLines('/**\n * Doc.\n */\nexport const x = 1;\n', 'a.ts')).toEqual({ code: 1, comment: 3, blank: 0 });
});

test('counts the continuation lines of a block comment opened after code as comment', () => {
  expect(countLines('a(); /* x\n y */\n', 'a.ts')).toEqual({ code: 1, comment: 1, blank: 0 });
});
