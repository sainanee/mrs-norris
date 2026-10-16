import { listComments, protectedComments } from '../../../src/adapters/node/comments.js';

test('listComments returns each comment once, ignoring comment-like template and JSX text', () => {
  const source = '// a\nconst u = `${b}//c`; /* d */\n/** e */\nexport const x = <p>http://f</p>;\nf(/* g */);\n';
  expect(listComments(source, 'a.tsx')).toEqual(['// a', '/* d */', '/** e */', '/* g */']);
});

const SOURCE = [
  '// Copyright 2026 Acme. MIT License.',
  '',
  '// eslint-disable-next-line no-console',
  "console.log('loaded');",
  '// TODO(#123) fix',
  '// TODO tidy',
  '/** Adds. */',
  'export function f() {}',
  '/** Internal. */',
  'function g() {}',
  '',
].join('\n');

const ALWAYS = ['// Copyright 2026 Acme. MIT License.', '// eslint-disable-next-line no-console', '// TODO(#123) fix'];

test.each([
  [false, ALWAYS],
  [true, [...ALWAYS, '/** Adds. */']],
])('protectedComments with publicSurface %s', (publicSurface, expected) => {
  expect(protectedComments(SOURCE, 'a.ts', { publicSurface })).toEqual(expected);
});
