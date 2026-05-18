import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { parseArguments } from '../bin/arguments.js';

test('parseArguments treats a hash positional as a commit ref', () => {
  const commitRef = 'a1b2c3d4e5f678901234567890abcdef12345678';

  expect(parseArguments(['-w', commitRef])).toEqual({
    commitRef,
    pullRequestUrl: null,
    requestedPath: resolve(process.cwd()),
    walkthrough: true,
  });
});

test('parseArguments keeps existing hash-like paths as repository paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-cli-'));
  const repositoryPath = join(directory, 'deadbeef');

  try {
    await mkdir(repositoryPath);

    expect(parseArguments([repositoryPath])).toEqual({
      commitRef: null,
      pullRequestUrl: null,
      requestedPath: repositoryPath,
      walkthrough: false,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('parseArguments treats GitHub pull request URLs as review sources', () => {
  const pullRequestUrl = 'https://github.com/nkzw-tech/codiff/pull/3';

  expect(parseArguments([pullRequestUrl])).toEqual({
    commitRef: null,
    pullRequestUrl,
    requestedPath: resolve(process.cwd()),
    walkthrough: false,
  });
});
