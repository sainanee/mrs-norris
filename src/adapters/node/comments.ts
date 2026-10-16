import { parseSource } from './tokens.js';

const LICENSE = /license|copyright|spdx/i;
const DIRECTIVE =
  /eslint-|@ts-(ignore|expect-error|nocheck)|prettier-ignore|(istanbul|c8|v8) ignore|biome-ignore|#__PURE__|@vite-ignore|webpackChunkName/;
const TODO = /\b(TODO|FIXME)\b/;
const ISSUE_REF = /#\d+|[A-Z][A-Z0-9]+-\d+|https?:\/\//;

function commentRanges(source: string, fileName: string) {
  return parseSource(source, fileName).comments.map(({ pos, end }) => ({ end, text: source.slice(pos, end) }));
}

export function listComments(source: string, fileName: string): string[] {
  return commentRanges(source, fileName).map((c) => c.text);
}

/** Comments that the comment pass must keep: license header, tool directives, TODOs that reference an issue, and (on public surface) JSDoc on exports. */
export function protectedComments(source: string, fileName: string, opts: { publicSurface: boolean }): string[] {
  const docsExport = (end: number) => {
    const followedByExport = /\s*export\b/y;
    followedByExport.lastIndex = end;
    return followedByExport.test(source);
  };
  return commentRanges(source, fileName)
    .filter(
      ({ text, end }, i) =>
        (i === 0 && LICENSE.test(text)) ||
        DIRECTIVE.test(text) ||
        (TODO.test(text) && ISSUE_REF.test(text)) ||
        (opts.publicSurface && text.startsWith('/**') && docsExport(end)),
    )
    .map((c) => c.text);
}
