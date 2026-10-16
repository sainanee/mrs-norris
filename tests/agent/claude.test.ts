import { query, type Options, type PreToolUseHookInput, type Query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertApiKey, createClaudeAgent } from '../../src/agent/claude.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const root = '/repo';
const mockedQuery = vi.mocked(query);

function replyWith(...results: object[]) {
  for (const result of results) {
    mockedQuery.mockImplementationOnce(
      () =>
        (async function* () {
          yield { type: 'system', subtype: 'init' };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            total_cost_usd: 0.25,
            modelUsage: {
              m: { inputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 5, outputTokens: 7 },
            },
            ...result,
          };
        })() as unknown as Query,
    );
  }
}

const call = (n: number) => mockedQuery.mock.calls[n][0] as { prompt: string; options: Options };

beforeEach(() => mockedQuery.mockReset());

describe('edit', () => {
  test('runs in the repo with only file tools and no user settings or MCP servers', async () => {
    replyWith({ result: 'done' });
    await createClaudeAgent({ model: 'claude-opus-5-5', root }).edit('Remove foo.', { allowedPaths: ['src/a.ts'] });
    const { prompt, options } = call(0);
    expect(prompt).toBe(
      'Remove foo.\n\nOnly modify these files: src/a.ts. Do not create, delete or modify any other file.',
    );
    expect(options).toMatchObject({
      model: 'claude-opus-5-5',
      cwd: root,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
      permissionMode: 'default',
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
    });
    expect(options.systemPrompt).toContain(root);
    expect(options).not.toHaveProperty('allowedTools');
    expect(options.hooks!.PreToolUse![0].matcher).toBeUndefined();
  });

  async function decide(repo: string, allowedPaths: string[], toolName: string, input: Record<string, unknown>) {
    replyWith({ result: 'done' });
    await createClaudeAgent({ model: 'm', root: repo }).edit('x', { allowedPaths });
    const canUseTool = mockedQuery.mock.lastCall![0].options!.canUseTool!;
    const signal = new AbortController().signal;
    return (await canUseTool(toolName, input, { signal, toolUseID: 't', requestId: 'r' }))?.behavior;
  }

  test.each([
    ['Edit', { file_path: path.join(root, 'src/a.ts') }, 'allow'],
    ['Write', { file_path: 'src/a.ts' }, 'allow'],
    ['Edit', { file_path: path.join(root, 'src/b.ts') }, 'deny'],
    ['Read', { file_path: path.join(root, 'src/b.ts') }, 'allow'],
    ['Read', { file_path: '/home/me/.aws/credentials' }, 'deny'],
    ['Grep', { pattern: 'foo' }, 'allow'],
    ['Glob', { pattern: 'src/**/*.ts' }, 'allow'],
    ['Glob', { pattern: '*', path: '/home/me' }, 'deny'],
    ['Glob', { pattern: '../**' }, 'deny'],
    ['Glob', { pattern: '{..,x}/**' }, 'deny'],
    ['Grep', { pattern: '.', path: '~' }, 'deny'],
    ['Grep', { pattern: '.', path: '~/.aws' }, 'deny'],
    ['Read', { file_path: '~/.aws/credentials' }, 'deny'],
    ['Grep', { pattern: '.', path: ' /etc' }, 'deny'],
  ])('%s %o → %s', async (toolName, input, behavior) => {
    expect(await decide(root, ['src/a.ts'], toolName, input)).toBe(behavior);
  });

  /** A repo with `own.ts`, and `link.ts` / `dangling.ts` linking to an existing / missing file outside it. */
  async function repoWithOutsideLink() {
    const tmp = path.resolve(import.meta.dirname, '../../.tmp');
    await fs.mkdir(tmp, { recursive: true });
    const repo = await fs.mkdtemp(path.join(tmp, 'agent-'));
    const outside = await fs.mkdtemp(path.join(tmp, 'outside-'));
    await fs.writeFile(path.join(outside, 'secret.ts'), '');
    await fs.writeFile(path.join(repo, 'own.ts'), '');
    await fs.symlink(path.join(outside, 'secret.ts'), path.join(repo, 'link.ts'));
    await fs.symlink(path.join(outside, 'missing.ts'), path.join(repo, 'dangling.ts'));
    return repo;
  }

  test.each([
    ['Edit', 'link.ts'],
    ['Write', 'dangling.ts'],
  ])('denies %s on an allowed path %s that is a symlink out of the repo', async (toolName, file) => {
    const repo = await repoWithOutsideLink();
    expect(await decide(repo, [file], toolName, { file_path: path.join(repo, file) })).toBe('deny');
  });

  test('the PreToolUse hook denies reading an in-repo symlink that points outside', async () => {
    const repo = await repoWithOutsideLink();
    replyWith({ result: 'done' });
    await createClaudeAgent({ model: 'm', root: repo }).edit('x', { allowedPaths: [] });
    const hook = call(0).options.hooks!.PreToolUse![0].hooks[0];
    const read = (file: string) =>
      hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: path.join(repo, file) },
        } as PreToolUseHookInput,
        't',
        { signal: new AbortController().signal },
      );
    expect(await read('link.ts')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await read('own.ts')).toEqual({});
  });

  test('throws when the run ends in an error', async () => {
    replyWith({ subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] });
    await expect(createClaudeAgent({ model: 'm', root }).edit('x', { allowedPaths: [] })).rejects.toThrow(
      /too many turns/,
    );
  });
});

describe('judge', () => {
  const schema = z.object({ unused: z.boolean() });

  test('read-only run that retries once with the error and accumulates usage', async () => {
    replyWith({ result: '{"unused":"yes"}' }, { result: '{"unused":true}' });
    const agent = createClaudeAgent({ model: 'm', root });
    await expect(agent.judge('Is foo unused?', schema)).resolves.toEqual({ unused: true });
    expect(call(0).options.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(call(0).prompt).toContain(JSON.stringify(z.toJSONSchema(schema)));
    expect(call(1).prompt).toContain(call(0).prompt);
    expect(call(1).prompt).toContain('expected boolean');
    expect(agent.usage()).toEqual({ inputTokens: 230, outputTokens: 14, costUsd: 0.5 });
  });

  test('throws after the retry also fails', async () => {
    replyWith({ result: 'no idea' }, { result: '{"unused":"yes"}' });
    await expect(createClaudeAgent({ model: 'm', root }).judge('q', schema)).rejects.toThrow(/unused/);
    expect(mockedQuery).toHaveBeenCalledTimes(2);
  });
});

test('assertApiKey throws when ANTHROPIC_API_KEY is missing', () => {
  expect(() => assertApiKey({})).toThrow(
    'ANTHROPIC_API_KEY is not set. Get a key at https://console.anthropic.com and export it before running mrs-norris.',
  );
});

test('assertApiKey passes when ANTHROPIC_API_KEY is set', () => {
  expect(() => assertApiKey({ ANTHROPIC_API_KEY: 'x' })).not.toThrow();
});
