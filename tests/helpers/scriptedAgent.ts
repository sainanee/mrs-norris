import type { z } from 'zod';
import type { Agent } from '../../src/agent/types.js';
import type { Usage } from '../../src/types.js';

interface Handlers {
  judge?: (prompt: string) => unknown;
  edit?: (prompt: string, opts: { allowedPaths: string[] }) => Promise<void>;
}

export class ScriptedAgent implements Agent {
  prompts: string[] = [];

  constructor(private handlers: Handlers) {}

  async judge<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
    if (!this.handlers.judge) throw new Error('ScriptedAgent: no judge handler');
    this.prompts.push(prompt);
    return schema.parse(this.handlers.judge(prompt));
  }

  async edit(prompt: string, opts: { allowedPaths: string[] }): Promise<void> {
    if (!this.handlers.edit) throw new Error('ScriptedAgent: no edit handler');
    this.prompts.push(prompt);
    await this.handlers.edit(prompt, opts);
  }

  usage(): Usage {
    const calls = this.prompts.length;
    return { inputTokens: 10 * calls, outputTokens: 5 * calls, costUsd: 0.01 * calls };
  }
}
