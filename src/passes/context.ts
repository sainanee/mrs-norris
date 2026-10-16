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
