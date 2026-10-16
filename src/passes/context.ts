import type { Agent } from '../agent/types.js';
import type { Config } from '../config.js';
import type { Git } from '../git.js';
import type {
  ChangeRecord,
  DeadCodeCandidate,
  PackageConfig,
  PlannedChange,
  ProofResult,
  PublicSurface,
  RunLog,
} from '../types.js';

export interface Scope {
  includes(file: string): boolean;
}

export interface PassContext {
  root: string;
  config: Config;
  git: Git;
  agent: Agent;
  log: RunLog;
  scope: Scope;
  /** Keyed by package dir. */
  surfaces: Map<string, PublicSurface>;
  verify: (change: PlannedChange, apply: () => Promise<void>, proof?: () => Promise<ProofResult>) => Promise<ChangeRecord>;
  findDeadCode: (pkg: PackageConfig) => Promise<DeadCodeCandidate[]>;
}

/** Whether the file is in the public surface of a library package; the package is the one with the longest dir containing the file. */
export function isPublicFile(ctx: PassContext, file: string): boolean {
  const dirs = [...ctx.surfaces.keys()].filter((dir) => file.startsWith(`${dir}/`));
  const surface = ctx.surfaces.get(dirs.sort((a, b) => b.length - a.length)[0] ?? '.');
  return surface?.isLibrary === true && surface.files.includes(file);
}
