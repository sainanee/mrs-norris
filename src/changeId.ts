import { createHash } from 'node:crypto';
import type { Category } from './types.js';

export function changeId(category: Category, file: string, symbol = ''): string {
  return `mn-${createHash('sha256').update(`${category}|${file}|${symbol}`).digest('hex').slice(0, 10)}`;
}
