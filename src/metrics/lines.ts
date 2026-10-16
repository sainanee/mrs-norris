import ts from 'typescript';

/** Counts lines by kind; a line holding code plus a trailing comment is code. */
export function countLines(source: string, fileName: string): { code: number; comment: number; blank: number } {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
  const lineCount = file.getLineStarts().length - (source.endsWith('\n') ? 1 : 0);
  const hasCode = new Array<boolean>(lineCount).fill(false);
  const hasComment = new Array<boolean>(lineCount).fill(false);
  const mark = (flags: boolean[], start: number, end: number) => {
    const last = file.getLineAndCharacterOfPosition(end - 1).line;
    for (let line = file.getLineAndCharacterOfPosition(start).line; line <= last; line++) flags[line] = true;
  };

  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(file);
    if (children.length) return children.forEach(visit);
    for (const comment of ts.getLeadingCommentRanges(source, node.pos) ?? []) mark(hasComment, comment.pos, comment.end);
    const isWhitespace = node.kind === ts.SyntaxKind.JsxText && (node as ts.JsxText).containsOnlyTriviaWhiteSpaces;
    if (node.end > node.getStart(file) && !isWhitespace) mark(hasCode, node.getStart(file), node.end);
  };
  visit(file);

  const counts = { code: 0, comment: 0, blank: 0 };
  for (let line = 0; line < lineCount; line++) counts[hasCode[line] ? 'code' : hasComment[line] ? 'comment' : 'blank']++;
  return counts;
}
