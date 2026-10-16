import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
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

// Resolves symlinks through the deepest existing ancestor, so a new file under a symlinked
// directory is judged by where it would really land.
function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(realPath(parent), path.basename(file));
  }
}

export function createClaudeAgent(opts: { model: string; root: string }): Agent {
  const root = path.resolve(opts.root);
  const realRoot = realPath(root);
  const total: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  const real = (file: unknown) => realPath(path.resolve(root, String(file)));
  const inRepo = (file: unknown) => {
    const rel = path.relative(realRoot, real(file));
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };

  function permitted(toolName: string, input: Record<string, unknown>, writable: Set<string>): boolean {
    switch (toolName) {
      case 'Read':
        return inRepo(input.file_path);
      case 'Grep':
        return inRepo(input.path ?? root);
      case 'Glob': {
        const pattern = String(input.pattern);
        return inRepo(input.path ?? root) && !path.isAbsolute(pattern) && !pattern.split('/').includes('..');
      }
      case 'Edit':
      case 'Write':
        return inRepo(input.file_path) && writable.has(real(input.file_path));
      default:
        return false;
    }
  }

  async function run(prompt: string, tools: string[], allowedPaths: string[]): Promise<string> {
    const writable = new Set(allowedPaths.map(real));
    // Nothing is in allowedTools and the mode is 'default', so every tool call that needs
    // approval comes here; a stranger's repo must not steer reads or writes outside itself.
    const canUseTool: CanUseTool = async (toolName, input) =>
      permitted(toolName, input, writable)
        ? { behavior: 'allow' }
        : {
            behavior: 'deny',
            message: `Not allowed: only read inside ${root}; only modify: ${allowedPaths.join(', ') || 'nothing'}`,
          };

    const messages = query({
      prompt,
      options: {
        model: opts.model,
        cwd: root,
        // An omitted systemPrompt is sent as empty, and the claude_code preset pulls in auto-memory
        // and the user's environment, so give the model the repo root it needs for absolute paths.
        systemPrompt: `You are mrs-norris's code-cleanup assistant, working in the repository at ${root}. Always use absolute paths under ${root}. Never read or write anything outside it.`,
        tools,
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
