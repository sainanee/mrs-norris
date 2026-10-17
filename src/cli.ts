#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { initProject } from './commands/init.js';
import { parseOnly, runMrsNorris } from './commands/run.js';
import { consoleIO } from './io.js';
import { CATEGORIES } from './types.js';

export function buildProgram(): Command {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const program = new Command().name('mrs-norris').version(version);
  program
    .command('init')
    .description('detect the project and write .mrs-norris/config.yaml')
    .option('-y, --yes', 'accept the guessed commands without asking')
    .action(async (opts: { yes?: boolean }) => {
      await initProject(process.cwd(), consoleIO(), { yes: opts.yes ?? false });
    });
  program
    .command('run [paths...]', { isDefault: true })
    .description('shrink the repo on a new mrs-norris/<date> branch (the default command)')
    .option('--since <ref>', 'only touch files changed since this git ref')
    .option('--only <list>', `comma-separated categories to run (${CATEGORIES.join(', ')})`)
    .option('--model <id>', 'Claude model to use instead of the configured one')
    .option('-y, --yes', 'accept the guessed commands if no config exists yet')
    .action(async (paths: string[], opts: { since?: string; only?: string; model?: string; yes?: boolean }) => {
      const only = opts.only === undefined ? undefined : parseOnly(opts.only);
      await runMrsNorris(process.cwd(), { ...opts, paths, only }, { io: consoleIO() });
    });
  return program;
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href) {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
