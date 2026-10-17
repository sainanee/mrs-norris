import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { makeTempRepo } from './helpers/tempRepo.js';

const pkg = {
  name: 'app',
  dir: '.',
  language: 'typescript' as const,
  runner: 'vitest' as const,
  packageManager: 'npm' as const,
  commands: { test: 'npx vitest run', typecheck: 'npx tsc --noEmit' },
};

describe('config', () => {
  test('saveConfig then loadConfig round-trips', async () => {
    const root = await makeTempRepo({ 'a.txt': 'x' });
    const config = { ...defaultConfig([pkg]), style: ['prefer early returns'], allowPublicApiChanges: true };
    await saveConfig(root, config);
    expect(await loadConfig(root)).toEqual(config);
  });

  test('loadConfig returns null when there is no config file', async () => {
    const root = await makeTempRepo({ 'a.txt': 'x' });
    expect(await loadConfig(root)).toBeNull();
  });

  test('saveConfig ignores reports and state', async () => {
    const root = await makeTempRepo({ 'a.txt': 'x' });
    await saveConfig(root, defaultConfig([pkg]));
    expect(await fs.readFile(path.join(root, '.mrs-norris/.gitignore'), 'utf8')).toBe('reports/\nstate.json\n');
  });

  test('a config without packages is invalid', async () => {
    const root = await makeTempRepo({ 'a.txt': 'x' });
    await saveConfig(root, defaultConfig([]));
    await expect(loadConfig(root)).rejects.toThrow('.mrs-norris/config.yaml\npackages: must list at least one package');
  });

  test('an invalid file reports the config path and the offending field', async () => {
    const root = await makeTempRepo({ 'a.txt': 'x' });
    await saveConfig(root, defaultConfig([pkg]));
    const file = path.join(root, '.mrs-norris/config.yaml');
    const text = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, text.replace(/categories:[\s\S]*?\nignore:/, 'categories: [cleanup]\nignore:'));
    await expect(loadConfig(root)).rejects.toThrow(/\.mrs-norris\/config\.yaml[\s\S]*categories/);
  });
});
