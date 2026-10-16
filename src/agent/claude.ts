import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { z } from 'zod';
import type { Usage } from '../types.js';
import { parseJsonReply } from './json.js';
import type { Agent } from './types.js';

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const WRITE_TOOLS = ['Edit', 'Write'];

export function assertApiKey(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Get a key at https://console.anthropic.com and export it before running mrs-norris.',
    );
  }
}

export function createClaudeAgent(opts: { model: string; root: string }): Agent {
  const total: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  async function run(prompt: string, tools: string[], allowedPaths: string[]): Promise<string> {
    const writable = new Set(allowedPaths.map((p) => path.resolve(opts.root, p)));
    // Write tools are left out of allowedTools, so in 'default' mode every Edit/Write call
    // (and any read outside the repo) comes here instead of being auto-approved.
    const canUseTool: CanUseTool = async (toolName, input) =>
      WRITE_TOOLS.includes(toolName) && writable.has(path.resolve(opts.root, String(input.file_path)))
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: `Not allowed. Only these files may be modified: ${allowedPaths.join(', ')}` };

    const messages = query({
      prompt,
      options: {
        model: opts.model,
        cwd: opts.root,
        tools,
        allowedTools: READ_TOOLS,
        permissionMode: 'default',
        canUseTool,
        // We run in other people's repos: ignore their (and our user's) settings, hooks, CLAUDE.md and MCP servers.
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
      },
    });
    for await (const message of messages) {
      if (message.type !== 'result') continue;
      for (const usage of Object.values(message.modelUsage)) {
        total.inputTokens += usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
        total.outputTokens += usage.outputTokens;
      }
      total.costUsd += message.total_cost_usd;
      if (message.subtype !== 'success') throw new Error(`Claude stopped (${message.subtype}): ${message.errors.join('; ')}`);
      if (message.is_error) throw new Error(`Claude failed: ${message.result}`);
      return message.result;
    }
    throw new Error('Claude ended without a result');
  }

  return {
    async judge(prompt, schema) {
      const request = `${prompt}\n\nReply with a single JSON object matching this JSON schema:\n${JSON.stringify(z.toJSONSchema(schema))}`;
      const reply = await run(request, READ_TOOLS, []);
      try {
        return parseJsonReply(reply, schema);
      } catch (error) {
        const retry = `${request}\n\nYour previous reply was rejected: ${(error as Error).message}\nReply again with only the corrected JSON object.`;
        return parseJsonReply(await run(retry, READ_TOOLS, []), schema);
      }
    },
    async edit(prompt, { allowedPaths }) {
      await run(
        `${prompt}\n\nOnly modify these files: ${allowedPaths.join(', ')}. Do not create, delete or modify any other file.`,
        [...READ_TOOLS, ...WRITE_TOOLS],
        allowedPaths,
      );
    },
    usage: () => ({ ...total }),
  };
}
