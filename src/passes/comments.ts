import fs from 'node:fs/promises';
import path from 'node:path';
import { listComments, protectedComments } from '../adapters/node/comments.js';
import { codeTokensEqual } from '../adapters/node/tokens.js';
import { changeId } from '../changeId.js';
import { isSourceFile } from '../metrics/classify.js';
import type { ProofResult } from '../types.js';
import { isEditable, isPublicFile, type PassContext } from './context.js';

export async function runCommentPass(ctx: PassContext): Promise<void> {
  // git ls-files lists paths sorted.
  const files = (await ctx.git.trackedFiles()).filter((file) => isSourceFile(file) && isEditable(ctx, file));
  for (const file of files) {
    const before = await fs.readFile(path.join(ctx.root, file), 'utf8');
    const kept = protectedComments(before, file, { publicSurface: isPublicFile(ctx, file) });
    if (listComments(before, file).length === kept.length) continue;
    const proof = async (): Promise<ProofResult> => {
      const after = await fs.readFile(path.join(ctx.root, file), 'utf8');
      if (!codeTokensEqual(before, after, file)) return { ok: false, reason: 'code changed, not just comments' };
      // Matched as a multiset of real comments, so duplicates count and string literals don't.
      const remaining = listComments(after, file);
      const removed = kept.find((comment) => {
        const i = remaining.indexOf(comment);
        if (i !== -1) remaining.splice(i, 1);
        return i === -1;
      });
      return removed === undefined ? { ok: true } : { ok: false, reason: `removed a protected comment: ${removed.slice(0, 60)}` };
    };
    await ctx.verify(
      {
        id: changeId('comments', file),
        category: 'comments',
        title: `Trim redundant comments in ${file}`,
        reason: 'Removed comments that restate the code.',
        allowedPaths: [file],
      },
      () => ctx.agent.edit(editPrompt(file, ctx.config.style), { allowedPaths: [file] }),
      proof,
    );
  }
}

function editPrompt(file: string, style: string[]): string {
  const styleRules = style.length ? `\n\nAlso follow this repository's style rules:\n${style.map((line) => `- ${line}`).join('\n')}` : '';
  return `Trim comments in ${file}.

Remove inline comments that restate the code (like \`// increment counter\`) and stale comments that no longer match the code.

Never remove:
- any comment containing \`@\` or \`#\`
- triple-slash directives (\`/// <reference ... />\`)
- tool and bundler pragmas (eslint, prettier, istanbul/c8/v8 coverage, biome, webpack magic comments, sourceMappingURL, __PURE__, __NO_SIDE_EFFECTS__)
- license or copyright headers
- TODO and FIXME comments
- JSDoc/TSDoc on public API
- comments that explain why something non-obvious is done

Don't change any code, whitespace inside strings, or formatting beyond removing comment lines.${styleRules}`;
}
