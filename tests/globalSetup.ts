import fs from 'node:fs/promises';
import path from 'node:path';

const tmpDir = path.resolve(import.meta.dirname, '../.tmp');

async function emptyTmp(): Promise<void> {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
}

export const setup = emptyTmp;
export const teardown = emptyTmp;
