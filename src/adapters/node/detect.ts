import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import type { PackageCommands, PackageConfig, PackageManager, Runner } from '../../types.js';

export interface PackageJson {
  name?: string;
  private?: boolean;
  workspaces?: string[] | { packages?: string[] };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: unknown;
  main?: string;
  module?: string;
  types?: string;
}

type DetectedPackage = Omit<PackageConfig, 'commands'>;

const RUNNERS: Runner[] = ['vitest', 'jest', 'mocha'];

const exists = (file: string) => fs.access(file).then(() => true, () => false);

export async function readPackageJson(dir: string): Promise<PackageJson> {
  const text = await fs.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => '{}');
  return JSON.parse(text) as PackageJson;
}

const hasDep = (pkg: PackageJson, name: string) =>
  name in { ...pkg.dependencies, ...pkg.devDependencies };

async function workspaceGlobs(root: string, rootPkg: PackageJson): Promise<string[] | undefined> {
  const { workspaces } = rootPkg;
  if (workspaces) return Array.isArray(workspaces) ? workspaces : workspaces.packages;
  const text = await fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8').catch(() => '');
  return (parse(text) as { packages?: string[] } | null)?.packages;
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  return (await exists(path.join(root, 'yarn.lock'))) ? 'yarn' : 'npm';
}

export async function detectNodePackages(root: string): Promise<DetectedPackage[]> {
  const rootPkg = await readPackageJson(root);
  const globs = await workspaceGlobs(root, rootPkg);
  const dirs = globs
    ? (await fg(globs.map((glob) => `${glob}/package.json`), { cwd: root, ignore: ['**/node_modules/**'] }))
        .map((manifest) => path.posix.dirname(manifest))
        .sort()
    : ['.'];
  const packageManager = await detectPackageManager(root);

  return Promise.all(
    dirs.map(async (dir) => {
      const pkg = await readPackageJson(path.join(root, dir));
      const typescript =
        hasDep(pkg, 'typescript') ||
        (await exists(path.join(root, dir, 'tsconfig.json'))) ||
        (await exists(path.join(root, 'tsconfig.json')));
      return {
        name: pkg.name ?? path.basename(path.resolve(root, dir)),
        dir,
        language: typescript ? 'typescript' : 'javascript',
        runner: RUNNERS.find((runner) => hasDep(pkg, runner)) ?? RUNNERS.find((runner) => hasDep(rootPkg, runner)) ?? null,
        packageManager,
      };
    }),
  );
}

export async function guessNodeCommands(root: string, pkg: DetectedPackage): Promise<PackageCommands> {
  const { scripts = {} } = await readPackageJson(path.join(root, pkg.dir));
  const run = (script: string) => `${pkg.packageManager} run ${script}`;
  const commands: PackageCommands = { test: scripts.test ? run('test') : '' };
  if (scripts.typecheck) commands.typecheck = run('typecheck');
  else if (pkg.language === 'typescript') commands.typecheck = 'npx tsc --noEmit';
  if (scripts.lint) commands.lint = run('lint');
  return commands;
}
