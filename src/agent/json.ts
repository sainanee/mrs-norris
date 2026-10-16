import { z } from 'zod';

/** Parses the first fenced json block in `text`, or else the outermost `{...}`, against `schema`. */
export function parseJsonReply<T>(text: string, schema: z.ZodType<T>): T {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const result = schema.safeParse(JSON.parse(body));
  if (!result.success) throw new Error(`Reply does not match the schema:\n${z.prettifyError(result.error)}`);
  return result.data;
}
