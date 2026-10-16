import { parseSource } from './tokens.js';

// Directives, pragmas, licenses and TODOs; `///` only counts at the start of a comment.
const PROTECTED =
  /[@#]|^\/\/\/|eslint|prettier|istanbul|\b(c8|v8)\b|webpack|sourceMappingURL|__(PURE|NO_SIDE_EFFECTS)__|biome|license|copyright|spdx|\b(TODO|FIXME)\b/i;

export function listComments(source: string, fileName: string): string[] {
  return parseSource(source, fileName).comments.map(({ pos, end }) => source.slice(pos, end));
}

/** Comments the comment pass must keep: directives, pragmas, licenses and TODOs, plus every JSDoc block on a public surface. */
export function protectedComments(source: string, fileName: string, opts: { publicSurface: boolean }): string[] {
  return listComments(source, fileName).filter(
    (text) => PROTECTED.test(text) || (opts.publicSurface && text.startsWith('/**')),
  );
}
