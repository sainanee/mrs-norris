import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PublicSurface } from '../../types.js';
import { readPackageJson } from './detect.js';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];
const BUILD_DIR = /^(dist|build|lib)\//;
const REEXPORT = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"](\.[^'"]*)['"]/g;

const isFile = (file: string) => fs.stat(file).then((stat) => stat.isFile(), () => false);

const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

async function resolveModules(specifier: string): Promise<string[]> {
  const stem = specifier.replace(/(\.d)?\.[cm]?[jt]sx?$/, '');
  const candidates = [
    specifier,
    ...EXTENSIONS.map((ext) => specifier + ext),
    ...EXTENSIONS.map((ext) => stem + ext),
    ...EXTENSIONS.map((ext) => path.join(specifier, `index${ext}`)),
  ];
  if (specifier.includes('*')) return fg(candidates, { absolute: true });
  for (const candidate of candidates) if (await isFile(candidate)) return [candidate];
  return [];
}

async function resolveEntry(pkgRoot: string, entry: string): Promise<string[]> {
  const normalized = path.posix.normalize(entry);
  const swapped = normalized.replace(BUILD_DIR, 'src/');
  for (const target of new Set([swapped, normalized])) {
    const files = await resolveModules(path.join(pkgRoot, target));
    if (files.length > 0) return files;
  }
  return [];
}

export async function nodePublicSurface(root: string, pkgDir: string): Promise<PublicSurface> {
  const pkgRoot = path.join(root, pkgDir);
  const pkg = await readPackageJson(pkgRoot);
  const isLibrary = pkg.private !== true && [pkg.exports, pkg.main, pkg.module].some((entry) => entry !== undefined);
  if (!isLibrary) return { isLibrary, files: [] };

  const surface = new Set<string>();
  const entries = strings([pkg.exports, pkg.main, pkg.module, pkg.types]);
  const pending = (await Promise.all(entries.map((entry) => resolveEntry(pkgRoot, entry)))).flat();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (surface.has(file)) continue;
    surface.add(file);
    const source = await fs.readFile(file, 'utf8');
    for (const [, specifier] of source.matchAll(REEXPORT)) {
      pending.push(...(await resolveModules(path.resolve(path.dirname(file), specifier!))));
    }
  }

  const files = [...surface].map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
  return { isLibrary, files };
}
