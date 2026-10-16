#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { initProject } from './commands/init.js';
import { consoleIO } from './io.js';

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
  return program;
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href) {
  await buildProgram().parseAsync(process.argv);
}
