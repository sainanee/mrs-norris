import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { initProject } from '../../src/commands/init.js';
import type { IO } from '../../src/io.js';
import { makeTempRepo } from '../helpers/tempRepo.js';

function fakeIO(confirmAnswer: boolean, inputAnswers: string[] = []) {
  const printed: string[] = [];
  const io: IO = {
    print: (msg) => printed.push(msg),
    confirm: async () => confirmAnswer,
    input: async () => inputAnswers.shift() ?? '',
  };
  return { io, printed };
}

const vitestApp = (scripts: Record<string, string> = { test: 'vitest run' }) => ({
  'package.json': JSON.stringify({ name: 'app', scripts, devDependencies: { vitest: '^1' } }),
  'tsconfig.json': '{}',
});

describe('initProject', () => {
  test('--yes saves the guessed commands', async () => {
    const root = await makeTempRepo(vitestApp());
    const { io, printed } = fakeIO(false);
    await initProject(root, io, { yes: true });
    const config = await loadConfig(root);
    expect(config?.packages[0]?.commands).toEqual({ test: 'npm run test', typecheck: 'npx tsc --noEmit' });
    expect(printed.join('\n')).toContain('npm run test');
  });

  test('declining prompts per command, re-asks an empty test and omits empty typecheck and lint', async () => {
    const root = await makeTempRepo(vitestApp());
    const { io } = fakeIO(false, ['', 'npx vitest run', '', '']);
    const config = await initProject(root, io, { yes: false });
    expect(config.packages[0]?.commands).toEqual({ test: 'npx vitest run' });
    expect(await loadConfig(root)).toEqual(config);
  });

  test('--yes without a test script rejects and writes nothing', async () => {
    const root = await makeTempRepo(vitestApp({}));
    await expect(initProject(root, fakeIO(true).io, { yes: true })).rejects.toThrow(
      'No test command found for .. Run `mrs-norris init` interactively or edit .mrs-norris/config.yaml.',
    );
    await expect(fs.access(path.join(root, '.mrs-norris'))).rejects.toThrow();
  });

  test('warns when the test runner is not recognised', async () => {
    const root = await makeTempRepo({ 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'node t.js' } }) });
    const { io, printed } = fakeIO(true);
    await initProject(root, io, { yes: false });
    expect(printed.join('\n')).toContain('.: test runner not recognised (supported: jest, vitest, mocha).');
  });
});
