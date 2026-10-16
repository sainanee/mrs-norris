import { listComments, protectedComments } from '../../../src/adapters/node/comments.js';

test('listComments returns each comment once, ignoring comment-like template and JSX text', () => {
  const source = '// a\nconst u = `${b}//c`; /* d */\n/** e */\nexport const x = <p>http://f</p>;\nf(/* g */);\n';
  expect(listComments(source, 'a.tsx')).toEqual(['// a', '/* d */', '/** e */', '/* g */']);
});

const SOURCE = [
  '// Copyright 2026 Acme. MIT License.',
  '// increment counter',
  '/** Adds. */',
  '// eslint-disable-next-line no-console',
  'export function f() {}',
  '// TODO tidy',
  'export class C {',
  '  /** Size. */',
  '  size = 1;',
  '}',
  '',
].join('\n');

test.each([
  [false, ['// Copyright 2026 Acme. MIT License.', '// eslint-disable-next-line no-console', '// TODO tidy']],
  [
    true,
    [
      '// Copyright 2026 Acme. MIT License.',
      '/** Adds. */',
      '// eslint-disable-next-line no-console',
      '// TODO tidy',
      '/** Size. */',
    ],
  ],
])('protectedComments with publicSurface %s', (publicSurface, expected) => {
  expect(protectedComments(SOURCE, 'a.ts', { publicSurface })).toEqual(expected);
});

test.each([
  ['/** @jsx h */\nconst x = 1;\n', '/** @jsx h */'],
  ['import(/* webpackIgnore: true */ url);\n', '/* webpackIgnore: true */'],
  ['f();\n//# sourceMappingURL=a.js.map\n', '//# sourceMappingURL=a.js.map'],
  ['/// <reference types="node" />\nf();\n', '/// <reference types="node" />'],
  // Split so vitest does not read the pragma as this file's own environment.
  [`// @vitest-${'environment'} jsdom\nf();\n`, `// @vitest-${'environment'} jsdom`],
  ['const x = /* @__PURE__ */ f();\n', '/* @__PURE__ */'],
])('protectedComments keeps the pragma in %j', (source, comment) => {
  expect(protectedComments(source, 'a.ts', { publicSurface: false })).toEqual([comment]);
});
