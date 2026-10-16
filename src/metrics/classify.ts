import picomatch from 'picomatch';
import { PROTECTED_DOCS } from '../config.js';

export const matchesAny = (path: string, globs: string[]): boolean => picomatch.isMatch(path, globs, { dot: true });

export const isSourceFile = (path: string): boolean => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path);

export const isTestFile = (path: string): boolean =>
  /(^|\/)(__tests__|tests?)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

export const isDocFile = (path: string): boolean => matchesAny(path, PROTECTED_DOCS);
