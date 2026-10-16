import { defaultConfig, saveConfig, type Config } from '../config.js';
import { detectNodePackages, guessNodeCommands } from '../adapters/node/detect.js';
import type { IO } from '../io.js';
import type { PackageCommands, PackageConfig } from '../types.js';

const formatTable = (packages: PackageConfig[]): string => {
  const rows = [
    ['package', 'runner', 'test', 'typecheck', 'lint'],
    ...packages.map(({ dir, runner, commands }) => [
      dir,
      runner ?? '-',
      commands.test || '-',
      commands.typecheck ?? '-',
      commands.lint ?? '-',
    ]),
  ];
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd()).join('\n');
};

async function askCommands(io: IO, pkg: PackageConfig): Promise<PackageCommands> {
  let test = '';
  while (!test) test = (await io.input(`${pkg.dir}: test command`, pkg.commands.test)).trim();
  const commands: PackageCommands = { test };
  const typecheck = (await io.input(`${pkg.dir}: typecheck command (empty for none)`, pkg.commands.typecheck ?? '')).trim();
  const lint = (await io.input(`${pkg.dir}: lint command (empty for none)`, pkg.commands.lint ?? '')).trim();
  if (typecheck) commands.typecheck = typecheck;
  if (lint) commands.lint = lint;
  return commands;
}

export async function initProject(root: string, io: IO, opts: { yes: boolean }): Promise<Config> {
  const packages: PackageConfig[] = await Promise.all(
    (await detectNodePackages(root)).map(async (pkg) => ({ ...pkg, commands: await guessNodeCommands(root, pkg) })),
  );
  io.print(formatTable(packages));
  for (const pkg of packages) {
    if (!pkg.runner) {
      io.print(
        `${pkg.dir}: test runner not recognised (supported: jest, vitest, mocha). mrs-norris will rely on the test command's exit code only.`,
      );
    }
  }

  if (opts.yes) {
    const missing = packages.find((pkg) => !pkg.commands.test);
    if (missing) {
      throw new Error(
        `No test command found for ${missing.dir}. Run \`mrs-norris init\` interactively or edit .mrs-norris/config.yaml.`,
      );
    }
  } else if (!(await io.confirm('Use these commands?'))) {
    for (const pkg of packages) pkg.commands = await askCommands(io, pkg);
  }

  const config = defaultConfig(packages);
  await saveConfig(root, config);
  io.print('Wrote .mrs-norris/config.yaml');
  return config;
}
