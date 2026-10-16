import type { RunLog } from './types.js';

export function newRunLog(): RunLog {
  return { changes: [], findings: [], flaky: [] };
}
