import { z } from 'zod';
import { parseJsonReply } from '../../src/agent/json.js';

const schema = z.object({ unused: z.boolean() });

test.each([
  ['a fenced json block', 'Here you go:\n```json\n{"unused": true}\n```\nDone.'],
  ['a bare object', 'Verdict: {"unused": true}'],
])('parses %s', (_name, text) => {
  expect(parseJsonReply(text, schema)).toEqual({ unused: true });
});

test('throws with the zod issues when the object does not match', () => {
  expect(() => parseJsonReply('{"unused":"yes"}', schema)).toThrow(/unused/);
});
