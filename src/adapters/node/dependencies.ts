import fs from 'node:fs/promises';
import type { PackageManager } from '../../types.js';

const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

export const LOCKFILES: Record<PackageManager, string> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
};

export function lockfileUpdateCommand(pm: PackageManager): string {
  return {
    npm: 'npm install --package-lock-only --ignore-scripts',
    pnpm: 'pnpm install --lockfile-only --ignore-scripts',
    yarn: 'yarn install --mode update-lockfile',
  }[pm];
}

export async function removeDependency(pkgJsonPath: string, name: string): Promise<void> {
  const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as Partial<
    Record<(typeof SECTIONS)[number], Record<string, string>>
  >;
  for (const section of SECTIONS) delete pkg[section]?.[name];
  await fs.writeFile(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
