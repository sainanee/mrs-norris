import fs from 'node:fs/promises';
import path from 'node:path';
import { listComments, protectedComments } from '../adapters/node/comments.js';
import { codeTokensEqual } from '../adapters/node/tokens.js';
import { changeId } from '../changeId.js';
import { PROTECTED_DOCS } from '../config.js';
import { isSourceFile, matchesAny } from '../metrics/classify.js';
import type { ProofResult } from '../types.js';
import { isPublicFile, type PassContext } from './context.js';

export async function runCommentPass(ctx: PassContext): Promise<void> {
  const skip = [...ctx.config.ignore, ...PROTECTED_DOCS];
  // git ls-files lists paths sorted.
  const files = (await ctx.git.trackedFiles()).filter(
    (file) => isSourceFile(file) && ctx.scope.includes(file) && !matchesAny(file, skip),
  );
  for (const file of files) {
    const before = await fs.readFile(path.join(ctx.root, file), 'utf8');
    if (listComments(before, file).length === 0) continue;
    const kept = protectedComments(before, file, { publicSurface: isPublicFile(ctx, file) });
    const proof = async (): Promise<ProofResult> => {
      const after = await fs.readFile(path.join(ctx.root, file), 'utf8');
      if (!codeTokensEqual(before, after, file)) return { ok: false, reason: 'code changed, not just comments' };
      const removed = kept.find((comment) => !after.includes(comment));
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
- license or copyright headers
- JSDoc/TSDoc on public API
- tool directives (eslint-disable, @ts-expect-error, @ts-ignore, prettier-ignore, coverage-ignore pragmas)
- comments that explain why something non-obvious is done
- TODOs that reference an issue

Don't change any code, whitespace inside strings, or formatting beyond removing comment lines.${styleRules}`;
}
