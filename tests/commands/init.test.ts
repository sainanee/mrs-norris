import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultConfig, loadConfig, saveConfig } from '../../src/config.js';
import { initProject } from '../../src/commands/init.js';
import type { IO } from '../../src/io.js';
import { makeTempRepo } from '../helpers/tempRepo.js';

function fakeIO(confirmAnswer: boolean, inputAnswers: string[] = []) {
  const printed: string[] = [];
  const asked: string[] = [];
  const io: IO = {
    print: (msg) => printed.push(msg),
    confirm: async (msg) => {
      asked.push(msg);
      return confirmAnswer;
    },
    input: async () => inputAnswers.shift() ?? '',
  };
  return { io, printed, asked };
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

  test.each([
    {
      mode: '--yes',
      yes: true,
      confirm: true,
      error: '.mrs-norris/config.yaml already exists. Edit it, or delete it and run init again.',
      asked: [],
    },
    { mode: 'a declined prompt', yes: false, confirm: false, error: 'Aborted. .mrs-norris/config.yaml is unchanged.', asked: ['Overwrite existing .mrs-norris/config.yaml?'] },
  ])('with an existing config, $mode leaves it untouched', async ({ yes, confirm, error, asked }) => {
    const root = await makeTempRepo(vitestApp());
    const existing = { ...defaultConfig([]), model: 'kept' };
    await saveConfig(root, existing);
    const fake = fakeIO(confirm);
    await expect(initProject(root, fake.io, { yes })).rejects.toThrow(error);
    expect(fake.asked).toEqual(asked);
    expect(await fs.readFile(path.join(root, '.mrs-norris/config.yaml'), 'utf8')).toContain('model: kept');
  });

  test('a confirmed prompt overwrites an existing config', async () => {
    const root = await makeTempRepo(vitestApp());
    await saveConfig(root, { ...defaultConfig([]), model: 'old' });
    const config = await initProject(root, fakeIO(true).io, { yes: false });
    expect(await loadConfig(root)).toEqual(config);
    expect(config.model).not.toBe('old');
  });

  test('a repo without a package.json is refused', async () => {
    const root = await makeTempRepo({ 'main.py': 'print(1)\n' });
    await expect(initProject(root, fakeIO(true).io, { yes: true })).rejects.toThrow(
      `No packages found in ${root}. mrs-norris supports JS/TS projects with a package.json.`,
    );
    await expect(fs.access(path.join(root, '.mrs-norris'))).rejects.toThrow();
  });
});
