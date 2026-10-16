import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createClaudeAgent } from '../../src/agent/claude.js';
import { DEFAULT_MODEL } from '../../src/config.js';
import { makeTempRepo } from '../helpers/tempRepo.js';

describe.skipIf(process.env.MRS_NORRIS_LIVE !== '1')('Claude agent (live)', () => {
  test('judge returns a schema-valid object and edit changes only the allowed file', { timeout: 600_000 }, async () => {
    const root = await makeTempRepo({
      'a.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
      'b.ts': "import { add } from './a';\n\nexport const three = add(1, 2);\n",
    });
    const agent = createClaudeAgent({ model: DEFAULT_MODEL, root });

    const verdict = await agent.judge(
      'Is the function `add` in a.ts imported by any other file?',
      z.object({ imported: z.boolean() }),
    );
    expect(verdict).toEqual({ imported: true });

    await agent.edit('Rename the function `add` to `sum` everywhere in this repo.', { allowedPaths: ['a.ts'] });
    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: root });
    expect(stdout.trim()).toBe('M a.ts');
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toContain('function sum');
    expect(agent.usage().costUsd).toBeGreaterThan(0);
  });
});
