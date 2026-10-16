import ts from 'typescript';

interface ParsedSource {
  file: ts.SourceFile;
  leaves: ts.Node[];
  comments: ts.CommentRange[];
  /** Preorder node kinds with child counts and leaf text, which pins down the tree as well as the tokens. */
  shape: string[];
}

// A full parse, unlike a bare scanner, knows when `//` sits inside template or JSX text.
export function parseSource(source: string, fileName: string): ParsedSource {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
  const leaves: ts.Node[] = [];
  const comments = new Map<number, ts.CommentRange>();
  const shape: string[] = [];

  const visit = (node: ts.Node) => {
    // JSDoc nodes duplicate comment text that the comment ranges already report.
    const children = node.getChildren(file).filter((child) => !ts.isJSDoc(child));
    if (children.length) {
      shape.push(`${node.kind}/${children.length}`);
      return children.forEach(visit);
    }
    leaves.push(node);
    shape.push(`${node.kind}:${node.getText(file)}`);
    // A comment between two tokens on one line is both trailing and leading.
    for (const comment of [
      ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(source, node.end) ?? []),
    ]) {
      comments.set(comment.pos, comment);
    }
  };
  visit(file);

  return { file, leaves, comments: [...comments.values()], shape };
}

/** True when the two versions parse to the same tree with the same token text and shebang, so only comments and whitespace outside tokens differ. */
export function codeTokensEqual(before: string, after: string, fileName: string): boolean {
  const [a, b] = [parseSource(before, fileName).shape, parseSource(after, fileName).shape];
  // The shebang is trivia to the parser, but a bin cannot run without it.
  return ts.getShebang(before) === ts.getShebang(after) && a.length === b.length && a.every((entry, i) => entry === b[i]);
}
