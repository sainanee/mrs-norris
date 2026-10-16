export const CATEGORIES = ['dead-code', 'comments', 'test-writing', 'simplify', 'test-pruning'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Runner = 'jest' | 'vitest' | 'mocha';
export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export interface PackageCommands { test: string; typecheck?: string; lint?: string }
export interface PackageConfig {
  name: string; dir: string;            // repo-relative, '.' for root
  language: 'typescript' | 'javascript';
  runner: Runner | null; packageManager: PackageManager;
  commands: PackageCommands;
}
export interface PublicSurface { isLibrary: boolean; files: string[] } // repo-relative

export interface TestResult { id: string; file: string; status: 'passed' | 'failed' | 'skipped'; durationMs: number }
export interface TestRun { ok: boolean; results: TestResult[]; durationMs: number; reportMissing: boolean; output: string }

export interface DeadCodeCandidate { kind: 'file' | 'export' | 'dependency'; pkgDir: string; file: string; symbol?: string; line?: number }

export interface PlannedChange { id: string; category: Category; title: string; reason: string; allowedPaths: string[] }
export type ProofResult = { ok: true } | { ok: false; reason: string };
export interface ChangeRecord { id: string; category: Category; title: string; reason: string; files: string[];
  status: 'committed' | 'rolled-back' | 'skipped'; detail?: string; commit?: string }
export interface Finding { kind: 'possibly-unused' | 'public-export'; category: Category; file: string; symbol?: string; note: string }
export interface RunLog { changes: ChangeRecord[]; findings: Finding[]; flaky: string[] }

export interface Metrics { sourceLines: number; testLines: number; commentLines: number; testCount: number;
  testDurationMs: number; contextTokens: number; dependencies: number }
export interface Usage { inputTokens: number; outputTokens: number; costUsd: number }
