import { query, type CanUseTool, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
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
      allowedTools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'default',
      settingSources: [],
      strictMcpConfig: true,
    });
  });

  test.each([
    ['Edit', path.join(root, 'src/a.ts'), 'allow'],
    ['Write', 'src/a.ts', 'allow'],
    ['Edit', path.join(root, 'src/b.ts'), 'deny'],
    ['Read', '/etc/passwd', 'deny'],
  ])('%s on %s is %sed', async (toolName, filePath, behavior) => {
    replyWith({ result: 'done' });
    await createClaudeAgent({ model: 'm', root }).edit('x', { allowedPaths: ['src/a.ts'] });
    const canUseTool = call(0).options.canUseTool as CanUseTool;
    const signal = new AbortController().signal;
    const decision = await canUseTool(toolName, { file_path: filePath }, { signal, toolUseID: 't', requestId: 'r' });
    expect(decision?.behavior).toBe(behavior);
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

test.each([
  [{}, true],
  [{ ANTHROPIC_API_KEY: 'x' }, false],
])('assertApiKey(%o) throws: %s', (env, throws) => {
  const check = expect(() => assertApiKey(env));
  if (throws) {
    check.toThrow(
      'ANTHROPIC_API_KEY is not set. Get a key at https://console.anthropic.com and export it before running mrs-norris.',
    );
  } else {
    check.not.toThrow();
  }
});
