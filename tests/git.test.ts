import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Git } from '../src/git.js';
import { makeTempRepo } from './helpers/tempRepo.js';

async function setup(files: Record<string, string> = { 'a.txt': 'a\n' }) {
  const root = await makeTempRepo(files);
  return { root, git: new Git(root) };
}

describe('Git', () => {
  test('isClean is true on a fresh repo and false after editing a tracked file', async () => {
    const { root, git } = await setup();
    expect(await git.isClean()).toBe(true);
    await fs.writeFile(path.join(root, 'a.txt'), 'changed\n');
    expect(await git.isClean()).toBe(false);
  });

  test.each([
    { config: 'untracked', files: {}, expected: ['b.txt'] },
    { config: 'tracked and edited', files: { '.mrs-norris/config.yaml': 'model: a\n' }, expected: ['.mrs-norris/config.yaml', 'b.txt'] },
  ])('changedFiles lists $expected when .mrs-norris/config.yaml is $config', async ({ files, expected }) => {
    const { root, git } = await setup({ 'a.txt': 'a\n', ...files });
    await fs.mkdir(path.join(root, '.mrs-norris'), { recursive: true });
    await fs.writeFile(path.join(root, '.mrs-norris/config.yaml'), 'model: x\n');
    await fs.writeFile(path.join(root, 'b.txt'), 'b\n');
    expect((await git.changedFiles()).sort()).toEqual(expected);
  });

  test('createBranch suffixes the name when the branch already exists', async () => {
    const { git } = await setup();
    expect(await git.createBranch('mrs-norris/x')).toBe('mrs-norris/x');
    await git.checkout('main');
    expect(await git.createBranch('mrs-norris/x')).toBe('mrs-norris/x-2');
    expect(await git.currentBranch()).toBe('mrs-norris/x-2');
  });

  test('changedFiles lists modified, deleted and untracked files', async () => {
    const { root, git } = await setup({ 'mod.txt': '1\n', 'del.txt': '2\n' });
    await fs.writeFile(path.join(root, 'mod.txt'), 'changed\n');
    await fs.rm(path.join(root, 'del.txt'));
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub/new.txt'), 'new\n');
    expect((await git.changedFiles()).sort()).toEqual(['del.txt', 'mod.txt', 'sub/new.txt']);
  });

  test('rollback restores tracked files, removes untracked files and keeps ignored ones', async () => {
    const { root, git } = await setup({ 'mod.txt': 'orig\n', '.gitignore': 'ignored.txt\n' });
    await fs.writeFile(path.join(root, 'mod.txt'), 'changed\n');
    await fs.writeFile(path.join(root, 'new.txt'), 'new\n');
    await fs.writeFile(path.join(root, 'ignored.txt'), 'keep\n');
    await git.rollback();
    expect(await fs.readFile(path.join(root, 'mod.txt'), 'utf8')).toBe('orig\n');
    await expect(fs.access(path.join(root, 'new.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'ignored.txt'), 'utf8')).toBe('keep\n');
  });

  test('rollback keeps an untracked .mrs-norris/ directory only at the repo root', async () => {
    const { root, git } = await setup();
    await fs.mkdir(path.join(root, '.mrs-norris'));
    await fs.writeFile(path.join(root, '.mrs-norris/config.yaml'), 'model: x\n');
    await fs.mkdir(path.join(root, 'src/.mrs-norris'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/.mrs-norris/hide.ts'), 'x\n');
    await git.rollback();
    expect(await fs.readFile(path.join(root, '.mrs-norris/config.yaml'), 'utf8')).toBe('model: x\n');
    await expect(fs.access(path.join(root, 'src/.mrs-norris'))).rejects.toThrow();
  });

  test('changedFiles reports both paths of a staged rename as separate entries', async () => {
    const { root, git } = await setup({ 'old.txt': 'content\n' });
    await execa('git', ['mv', 'old.txt', 'new.txt'], { cwd: root });
    expect((await git.changedFiles()).sort()).toEqual(['new.txt', 'old.txt']);
  });

  test('commitAll commits everything but .mrs-norris/ and returns the new head sha', async () => {
    const { root, git } = await setup();
    await fs.writeFile(path.join(root, 'b.txt'), 'b\n');
    await fs.mkdir(path.join(root, '.mrs-norris'));
    await fs.writeFile(path.join(root, '.mrs-norris/config.yaml'), 'model: x\n');
    const sha = await git.commitAll('a\n\nMrs-Norris-Change-Id: mn-1');
    expect(sha).toBe(await git.head());
    const show = async (...args: string[]) => (await execa('git', args, { cwd: root })).stdout;
    expect(await show('log', '-1', '--format=%B')).toContain('Mrs-Norris-Change-Id: mn-1');
    expect(await show('show', '--format=', '--name-only')).toBe('b.txt');
    expect(await show('status', '--porcelain')).toBe('?? .mrs-norris/');
  });

  test('commitAll skips user hooks', async () => {
    const { root, git } = await setup();
    await fs.writeFile(path.join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await fs.writeFile(path.join(root, 'b.txt'), 'b\n');
    expect(await git.commitAll('change')).toBe(await git.head());
    expect(await git.isClean()).toBe(true);
  });

  test.each([
    ['get', 'const getter = 1;\n', []],
    ['$state', 'x\nconst $state = 1;\n', [{ file: 'f.ts', line: 2 }]],
    ['missing', 'nothing here\n', []],
  ])('grepWord(%s) matches whole words only', async (term, content, expected) => {
    const { git } = await setup({ 'f.ts': content });
    expect(await git.grepWord(term)).toEqual(expected);
  });

  test('grepWord skips binary files', async () => {
    const { git } = await setup({ 'bin.dat': 'needle\0\x01\x02', 'f.ts': 'ok\n' });
    expect(await git.grepWord('needle')).toEqual([]);
  });

  test('grepWord throws when git fails', async () => {
    const git = new Git(await fs.mkdtemp(path.join(os.tmpdir(), 'not-a-repo-')));
    await expect(git.grepWord('x')).rejects.toThrow('git grep failed');
  });

  test('close waits for a running command and rejects every later one', async () => {
    const { git } = await setup();
    const running = git.head();
    await git.close();
    expect(await running).toMatch(/^[0-9a-f]{40}$/);
    await expect(git.head()).rejects.toThrow('Aborted');
    await expect(git.grepWord('a')).rejects.toThrow('Aborted');
  });

  test('currentBranch is null on a detached HEAD', async () => {
    const { root, git } = await setup();
    expect(await git.currentBranch()).toBe('main');
    await execa('git', ['checkout', '--detach'], { cwd: root });
    expect(await git.currentBranch()).toBeNull();
  });

  test('trackedFiles and diffNames report files by repo-relative path', async () => {
    const { root, git } = await setup({ 'a.txt': 'a\n', 'src/b.txt': 'b\n' });
    const base = await git.head();
    await fs.writeFile(path.join(root, 'src/b.txt'), 'changed\n');
    await fs.writeFile(path.join(root, 'untracked.txt'), 'u\n');
    expect((await git.trackedFiles()).sort()).toEqual(['a.txt', 'src/b.txt']);
    await git.commitAll('change');
    expect(await git.diffNames(base)).toEqual(['src/b.txt', 'untracked.txt']);
  });
});
