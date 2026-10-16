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

async function resolveModule(specifier: string): Promise<string | null> {
  const stem = specifier.replace(/(\.d)?\.[cm]?[jt]sx?$/, '');
  const candidates = [
    specifier,
    ...EXTENSIONS.map((ext) => specifier + ext),
    ...EXTENSIONS.map((ext) => stem + ext),
    path.join(specifier, 'index.ts'),
  ];
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return null;
}

export async function nodePublicSurface(root: string, pkgDir: string): Promise<PublicSurface> {
  const pkgRoot = path.join(root, pkgDir);
  const pkg = await readPackageJson(pkgRoot);
  const isLibrary = pkg.private !== true && [pkg.exports, pkg.main, pkg.module].some((entry) => entry !== undefined);
  if (!isLibrary) return { isLibrary, files: [] };

  const entries = strings([pkg.exports, pkg.main, pkg.module, pkg.types]).map((entry) => {
    const normalized = path.posix.normalize(entry);
    return path.join(pkgRoot, normalized.replace(BUILD_DIR, 'src/'));
  });

  const surface = new Set<string>();
  const pending = (await Promise.all(entries.map(resolveModule))).filter((file) => file !== null);
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (surface.has(file)) continue;
    surface.add(file);
    const source = await fs.readFile(file, 'utf8');
    for (const [, specifier] of source.matchAll(REEXPORT)) {
      const resolved = await resolveModule(path.resolve(path.dirname(file), specifier!));
      if (resolved) pending.push(resolved);
    }
  }

  const files = [...surface].map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
  return { isLibrary, files };
}
