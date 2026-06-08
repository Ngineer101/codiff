import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const {
  CURSOR_NOT_FOUND_CODE,
  DEFAULT_CURSOR_MODEL,
  getCursorCommand,
  isCursorModelAvailabilityError,
  isCursorNotLoggedInError,
  normalizeCursorModel,
  runCursor,
} = require('../cursor.cjs') as {
  CURSOR_NOT_FOUND_CODE: string;
  DEFAULT_CURSOR_MODEL: string;
  getCursorCommand: () => string;
  isCursorModelAvailabilityError: (value: string) => boolean;
  isCursorNotLoggedInError: (value: string) => boolean;
  normalizeCursorModel: (value: unknown) => string;
  runCursor: (
    repoRoot: string,
    prompt: string,
    schema: unknown,
    outputName?: string,
    timeoutMessage?: string,
    options?: { model?: string },
  ) => Promise<string>;
};

test('normalizes Cursor model preferences to known models', () => {
  expect(normalizeCursorModel('sonnet-4')).toBe('sonnet-4');
  expect(normalizeCursorModel('gpt-4o')).toBe(DEFAULT_CURSOR_MODEL);
});

test('detects selected Cursor model availability failures', () => {
  expect(isCursorModelAvailabilityError('model_not_found: sonnet-4')).toBe(true);
  expect(isCursorModelAvailabilityError('Rate limit reached, please try again later.')).toBe(false);
});

test('detects Cursor Agent login failures', () => {
  expect(isCursorNotLoggedInError("Authentication required. Please run 'agent login' first.")).toBe(
    true,
  );
  expect(isCursorNotLoggedInError('Walkthrough is ready.')).toBe(false);
});

test('rejects invalid explicit Cursor CLI overrides', () => {
  const previousCursorPath = process.env.CODIFF_CURSOR_PATH;
  process.env.CODIFF_CURSOR_PATH = '/tmp/codiff-missing-cursor';

  try {
    expect(() => getCursorCommand()).toThrow('CODIFF_CURSOR_PATH');
    try {
      getCursorCommand();
    } catch (error) {
      expect(error).toMatchObject({ code: CURSOR_NOT_FOUND_CODE });
    }
  } finally {
    if (previousCursorPath == null) {
      delete process.env.CODIFF_CURSOR_PATH;
    } else {
      process.env.CODIFF_CURSOR_PATH = previousCursorPath;
    }
  }
});

test('runs Cursor Agent headless as a read-only structured-output call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-cursor-'));
  const fakeCursorPath = join(directory, 'agent');
  const argsPath = join(directory, 'args.txt');
  const previousCursorPath = process.env.CODIFF_CURSOR_PATH;

  try {
    await writeFile(
      fakeCursorPath,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const argsPath = ${JSON.stringify(argsPath)};
for (const arg of process.argv.slice(2)) {
  appendFileSync(argsPath, arg + '\\n');
}
process.stdout.write(${JSON.stringify('{"is_error":false,"result":"{\\"version\\":1,\\"reply\\":\\"ok\\"}"}')});
`,
    );
    await chmod(fakeCursorPath, 0o755);
    process.env.CODIFF_CURSOR_PATH = fakeCursorPath;

    await expect(
      runCursor(
        directory,
        'prompt',
        { properties: { reply: { type: 'string' }, version: { const: 1 } }, type: 'object' },
        'review-assistant.json',
        'Timed out.',
      ),
    ).resolves.toBe('{"version":1,"reply":"ok"}');

    const args = (await readFile(argsPath, 'utf8')).trim().split('\n');
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--mode');
    expect(args).toContain('ask');
    expect(args).toContain('--trust');
    expect(args).toContain('--workspace');
    expect(args).toContain(directory);
  } finally {
    if (previousCursorPath == null) {
      delete process.env.CODIFF_CURSOR_PATH;
    } else {
      process.env.CODIFF_CURSOR_PATH = previousCursorPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test('surfaces a helpful message when Cursor Agent is not authenticated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-cursor-'));
  const fakeCursorPath = join(directory, 'agent');
  const previousCursorPath = process.env.CODIFF_CURSOR_PATH;

  try {
    await writeFile(
      fakeCursorPath,
      `#!/usr/bin/env node
process.stderr.write(${JSON.stringify("Authentication required. Please run 'agent login' first.")});
process.exit(1);
`,
    );
    await chmod(fakeCursorPath, 0o755);
    process.env.CODIFF_CURSOR_PATH = fakeCursorPath;

    await expect(
      runCursor(
        directory,
        'prompt',
        { properties: { reply: { type: 'string' }, version: { const: 1 } }, type: 'object' },
        'review-assistant.json',
        'Timed out.',
      ),
    ).rejects.toThrow(/not authenticated/i);
  } finally {
    if (previousCursorPath == null) {
      delete process.env.CODIFF_CURSOR_PATH;
    } else {
      process.env.CODIFF_CURSOR_PATH = previousCursorPath;
    }
    await rm(directory, { force: true, recursive: true });
  }
});
