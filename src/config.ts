import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { CATEGORIES, type PackageConfig } from './types.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/__generated__/**',
  '**/migrations/**',
  '**/fixtures/**',
  '**/*.min.js',
  '**/*.d.ts',
];

export const PROTECTED_DOCS = ['**/*.md', '**/*.mdx', '**/*.rst', 'docs/**'];

export const CONFIG_DIR = '.mrs-norris';
const CONFIG_PATH = `${CONFIG_DIR}/config.yaml`;

const PackageSchema = z.object({
  name: z.string(),
  dir: z.string(),
  language: z.enum(['typescript', 'javascript']),
  runner: z.enum(['jest', 'vitest', 'mocha']).nullable(),
  packageManager: z.enum(['npm', 'pnpm', 'yarn']),
  commands: z.object({ test: z.string(), typecheck: z.string().optional(), lint: z.string().optional() }),
}) satisfies z.ZodType<PackageConfig>;

const ConfigSchema = z.object({
  version: z.literal(1),
  model: z.string(),
  categories: z.array(z.enum(CATEGORIES)),
  ignore: z.array(z.string()),
  allowPublicApiChanges: z.boolean(),
  style: z.array(z.string()),
  packages: z.array(PackageSchema),
});

export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(packages: PackageConfig[]): Config {
  return {
    version: 1,
    model: DEFAULT_MODEL,
    categories: [...CATEGORIES],
    ignore: DEFAULT_IGNORE,
    allowPublicApiChanges: false,
    style: [],
    packages,
  };
}

export async function loadConfig(root: string): Promise<Config | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, CONFIG_PATH), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const result = ConfigSchema.safeParse(parse(text));
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`${CONFIG_PATH}\n${issues.join('\n')}`);
}

export async function saveConfig(root: string, config: Config): Promise<void> {
  const dir = path.join(root, CONFIG_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.yaml'), stringify(config));
  await fs.writeFile(path.join(dir, '.gitignore'), 'reports/\nstate.json\n');
}
