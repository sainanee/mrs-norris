import type { z } from 'zod';
import type { Usage } from '../types.js';

export interface Agent {
  /** Read-only run (Read, Grep, Glob) whose reply is validated against `schema`. */
  judge<T>(prompt: string, schema: z.ZodType<T>): Promise<T>;
  /** Run that may also Edit and Write, but only the files in `allowedPaths`. */
  edit(prompt: string, opts: { allowedPaths: string[] }): Promise<void>;
  /** Stops every session still running. */
  abort(): void;
  usage(): Usage;
}
