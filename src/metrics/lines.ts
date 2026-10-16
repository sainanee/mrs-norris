import ts from 'typescript';
import { parseSource } from '../adapters/node/tokens.js';

/** Counts lines by kind; a line holding code plus a trailing comment is code. */
export function countLines(source: string, fileName: string): { code: number; comment: number; blank: number } {
  const { file, leaves, comments } = parseSource(source, fileName);
  const lineCount = file.getLineStarts().length - (source.endsWith('\n') ? 1 : 0);
  const hasCode = new Array<boolean>(lineCount).fill(false);
  const hasComment = new Array<boolean>(lineCount).fill(false);
  const mark = (flags: boolean[], start: number, end: number) => {
    const last = file.getLineAndCharacterOfPosition(end - 1).line;
    for (let line = file.getLineAndCharacterOfPosition(start).line; line <= last; line++) flags[line] = true;
  };

  for (const comment of comments) mark(hasComment, comment.pos, comment.end);
  for (const leaf of leaves) {
    const isWhitespace = leaf.kind === ts.SyntaxKind.JsxText && (leaf as ts.JsxText).containsOnlyTriviaWhiteSpaces;
    if (leaf.end > leaf.getStart(file) && !isWhitespace) mark(hasCode, leaf.getStart(file), leaf.end);
  }

  const counts = { code: 0, comment: 0, blank: 0 };
  for (let line = 0; line < lineCount; line++) counts[hasCode[line] ? 'code' : hasComment[line] ? 'comment' : 'blank']++;
  return counts;
}
