#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';

export function buildProgram(): Command {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return new Command().name('mrs-norris').version(version);
}

await buildProgram().parseAsync(process.argv);
