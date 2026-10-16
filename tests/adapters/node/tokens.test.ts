import { codeTokensEqual } from '../../../src/adapters/node/tokens.js';

const ADD = '// add two numbers\nexport function add(a: number, b: number) {\n  return a + b; // sum\n}\n';

test.each([
  ['only comments and whitespace differ', ADD, 'export function add(a: number,  b: number) {\n\n  return a + b;\n}\n', 'a.ts', true],
  ['an identifier is renamed', ADD, ADD.replace('return a + b', 'return a + c'), 'a.ts', false],
  ['a string literal changes', "const s = 'a  b';\n", "const s = 'a b';\n", 'a.ts', false],
  ['a .tsx file loses a comment line', '// x\nexport const App = () => <div>hi</div>;\n', 'export const App = () => <div>hi</div>;\n', 'a.tsx', true],
  ['template text after an interpolation looks like a comment', 'const u = `${base}//host`;\n', 'const u = `${base}//other`;\n', 'a.ts', false],
  ['JSX text looks like a comment', 'const e = <a>http://x</a>;\n', 'const e = <a>http://y</a>;\n', 'a.tsx', false],
  ['a shebang is removed', '#!/usr/bin/env node\n// start\nmain();\n', '// start\nmain();\n', 'a.ts', false],
  ['a JSDoc-style type changes', 'let x: ?A;\n', 'let x: ?B;\n', 'a.ts', false],
  ['joining lines changes semicolon insertion', 'function f() {\n  return\n  x;\n}\n', 'function f() {\n  return x;\n}\n', 'a.ts', false],
])('%s', (_, before, after, fileName, equal) => {
  expect(codeTokensEqual(before, after, fileName)).toBe(equal);
});
