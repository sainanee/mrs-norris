import { query, type CanUseTool, type HookCallback, type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { execa } from 'execa';
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
// directory is judged by where it would really land. Returns null when an entry exists but
// can't be resolved (a dangling or looping symlink): where a write to it lands is unknown.
function realPath(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    try {
      fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = realPath(path.dirname(file));
        return parent && path.join(parent, path.basename(file));
      }
    }
    return null;
  }
}

export function createClaudeAgent(opts: { model: string; root: string }): Agent {
  const root = path.resolve(opts.root);
  const realRoot = realPath(root)!;
  const total: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const running = new Set<AbortController>();

  const real = (file: string) => realPath(path.resolve(root, file));
  const inRepo = (file: unknown) => {
    // The CLI trims paths and expands a leading ~ before running a tool, so such a path
    // would not reach the file it resolves to here.
    if (typeof file !== 'string' || file.startsWith('~') || file !== file.trim()) return false;
    const target = real(file);
    if (target === null) return false;
    const rel = path.relative(realRoot, target);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };

  const ignoredFiles = new Map<string, Promise<boolean>>();
  // Gitignored files such as .env hold secrets more often than code. Only a target that is itself
  // a file can be checked: a search over a directory is not filtered per file. Anything but a
  // clear "not ignored" from git counts as ignored.
  const ignoredFile = (file: string): Promise<boolean> => {
    const target = real(file)!;
    if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) return Promise.resolve(false);
    let ignored = ignoredFiles.get(target);
    if (ignored === undefined) {
      ignored = execa('git', ['check-ignore', '-q', target], { cwd: root, reject: false }).then(({ exitCode }) => exitCode !== 1);
      ignoredFiles.set(target, ignored);
    }
    return ignored;
  };
  const readable = async (file: unknown) => inRepo(file) && !(await ignoredFile(file as string));

  async function permitted(toolName: string, input: Record<string, unknown>, writable: Set<string | null>): Promise<boolean> {
    switch (toolName) {
      case 'Read':
        return readable(input.file_path);
      case 'Grep':
        return readable(input.path ?? root);
      case 'Glob': {
        const pattern = String(input.pattern);
        return !path.isAbsolute(pattern) && !pattern.includes('..') && (await readable(input.path ?? root));
      }
      case 'Edit':
      case 'Write':
        return inRepo(input.file_path) && writable.has(real(input.file_path as string));
      default:
        return false;
    }
  }

  async function run(prompt: string, tools: string[], allowedPaths: string[]): Promise<string> {
    const writable = new Set(allowedPaths.map(real));
    const denial = `Not allowed: only read non-ignored files inside ${root}; only modify: ${allowedPaths.join(', ') || 'nothing'}`;
    // Nothing is in allowedTools and the mode is 'default', so calls that need approval come to
    // canUseTool. The CLI may still auto-approve in-repo reads without asking (an in-repo symlink
    // can point outside), so the PreToolUse hook, which sees every call, applies the same rules.
    const canUseTool: CanUseTool = async (toolName, input) =>
      (await permitted(toolName, input, writable)) ? { behavior: 'allow' } : { behavior: 'deny', message: denial };
    const guard: HookCallback = async (hookInput) => {
      const { tool_name, tool_input } = hookInput as PreToolUseHookInput;
      return (await permitted(tool_name, tool_input as Record<string, unknown>, writable))
        ? {}
        : {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denial },
          };
    };

    const abortController = new AbortController();
    running.add(abortController);
    try {
      const messages = query({
        prompt,
        options: {
          model: opts.model,
          abortController,
          cwd: root,
          // An omitted systemPrompt is sent as empty, and the claude_code preset pulls in auto-memory
          // and the user's environment, so give the model the repo root it needs for absolute paths.
          systemPrompt: `You are mrs-norris's code-cleanup assistant, working in the repository at ${root}. Always use absolute paths under ${root}. Never read or write anything outside it.`,
          tools,
          permissionMode: 'default',
          canUseTool,
          hooks: { PreToolUse: [{ hooks: [guard] }] },
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
    } finally {
      running.delete(abortController);
    }
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
    abort: () => {
      for (const controller of running) controller.abort();
    },
    usage: () => ({ ...total }),
  };
}
