// @ts-check

const { spawn } = require('node:child_process');
const { homedir } = require('node:os');
const { join } = require('node:path');
const {
  findExecutableOnPath,
  isExecutableFile,
  normalizeEnum,
  oneLine,
  parseJSONMessage,
} = require('./agent-shared.cjs');

const CURSOR_TIMEOUT_MS = 90_000;
const DEFAULT_CURSOR_MODEL = 'composer-2.5';
const FALLBACK_CURSOR_MODEL = 'sonnet-4';
const CURSOR_NOT_FOUND_CODE = 'CURSOR_NOT_FOUND';
const CURSOR_NOT_FOUND_MESSAGE =
  'Cursor Agent CLI was not found. Install Cursor Agent and verify `agent --version` works in Terminal. Codiff searches PATH, ~/.local/bin/agent, /opt/homebrew/bin/agent, and /usr/local/bin/agent. If the CLI is installed somewhere else, launch Codiff with `CODIFF_CURSOR_PATH=/absolute/path/to/agent codiff`.';
const CURSOR_NOT_LOGGED_IN_MESSAGE =
  'Cursor Agent is not authenticated. Run `agent login` in Terminal, or set CURSOR_API_KEY, then try again.';

/**
 * @typedef {{
 *   fallbackModel?: string;
 *   model?: string;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 * }} CursorOptions
 */
/**
 * @typedef {{
 *   id: string;
 *   label: string;
 * }} CursorModel
 */
/** @type {ReadonlyArray<CursorModel>} */
const CURSOR_MODELS = Object.freeze([
  {
    id: DEFAULT_CURSOR_MODEL,
    label: 'Default: Composer 2.5',
  },
  {
    id: 'sonnet-4',
    label: 'Balanced: Sonnet 4',
  },
  {
    id: 'gpt-5',
    label: 'Strong: GPT-5',
  },
]);
const CURSOR_MODEL_IDS = new Set(CURSOR_MODELS.map((model) => model.id));

/** @param {string} [detail] */
const createCursorNotFoundError = (detail) =>
  Object.assign(
    new Error(detail ? `${CURSOR_NOT_FOUND_MESSAGE} ${detail}` : CURSOR_NOT_FOUND_MESSAGE),
    {
      code: CURSOR_NOT_FOUND_CODE,
    },
  );

const getCursorCommand = () => {
  const cursorPath = process.env.CODIFF_CURSOR_PATH?.trim();
  if (cursorPath) {
    if (isExecutableFile(cursorPath)) {
      return cursorPath;
    }

    throw createCursorNotFoundError(
      `CODIFF_CURSOR_PATH is set to ${JSON.stringify(cursorPath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('agent');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of [
    join(homedir(), '.local/bin/agent'),
    '/opt/homebrew/bin/agent',
    '/usr/local/bin/agent',
  ]) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createCursorNotFoundError();
};

/** @param {unknown} error */
const isCursorNotFoundError = (error) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === CURSOR_NOT_FOUND_CODE || error.code === 'ENOENT'),
  );

/** @param {string} value */
const isCursorNotLoggedInError = (value) =>
  /\b(?:authentication required|please run 'agent login'|run 'agent login'|cursor_api_key|not authenticated|login first)\b/i.test(
    value,
  );

/** @param {unknown} value @returns {string} */
const normalizeCursorModel = (value) =>
  normalizeEnum(value, CURSOR_MODEL_IDS, DEFAULT_CURSOR_MODEL);

/** @param {string} value */
const isCursorModelAvailabilityError = (value) =>
  /\b(?:model_not_found|unknown model|invalid model|model is not available|not available for|not supported|does not have access|do not have access|don't have access|access to model|403|404)\b/i.test(
    value,
  );

/**
 * @param {unknown} error
 */
const getCursorLaunchError = (error) => {
  if (isCursorNotFoundError(error)) {
    return createCursorNotFoundError();
  }

  return error instanceof Error ? error : new Error(String(error ?? ''));
};

/** @param {string} prompt @param {unknown} schema */
const buildStructuredPrompt = (prompt, schema) =>
  `${prompt}\n\nReturn JSON only (no markdown fences or commentary) that satisfies this schema:\n${JSON.stringify(schema, null, 2)}`;

/**
 * Run Cursor Agent headless as a read-only structured-output call.
 *
 * @param {string} repoRoot
 * @param {string} prompt
 * @param {unknown} schema
 * @param {string} [_outputName]
 * @param {string} [timeoutMessage]
 * @param {CursorOptions} [options]
 */
const runCursor = async (
  repoRoot,
  prompt,
  schema,
  _outputName = 'cursor-output.json',
  timeoutMessage = 'Cursor Agent timed out.',
  options = {},
) => {
  const model = normalizeCursorModel(options.model);
  const fallbackModel = normalizeCursorModel(options.fallbackModel || FALLBACK_CURSOR_MODEL);
  const structuredPrompt = buildStructuredPrompt(prompt, schema);

  /** @param {string} cursorModel @returns {Promise<string>} */
  const invokeCursor = async (cursorModel) =>
    /** @type {Promise<string>} */ (
      new Promise((resolve, reject) => {
        let stderr = '';
        let stdout = '';
        let finished = false;

        const cursorCommand = getCursorCommand();
        const cursorArgs = [
          '--print',
          '--output-format',
          'json',
          '--mode',
          'ask',
          '--trust',
          '--workspace',
          repoRoot,
          '--model',
          cursorModel,
          structuredPrompt,
        ];
        const child = spawn(cursorCommand, cursorArgs, {
          cwd: repoRoot,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const timer = setTimeout(() => {
          if (!finished) {
            finished = true;
            child.kill('SIGTERM');
            reject(new Error(timeoutMessage));
          }
        }, CURSOR_TIMEOUT_MS);

        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.on('error', (error) => {
          finished = true;
          clearTimeout(timer);
          reject(getCursorLaunchError(error));
        });
        child.on('close', (code, signal) => {
          if (finished) {
            return;
          }

          finished = true;
          clearTimeout(timer);

          const combined = `${stderr}\n${stdout}`.trim();
          if (code !== 0) {
            const message = oneLine(
              combined,
              signal
                ? `Cursor Agent was terminated by ${signal}.`
                : `Cursor Agent exited with code ${code}.`,
            );
            reject(
              new Error(isCursorNotLoggedInError(message) ? CURSOR_NOT_LOGGED_IN_MESSAGE : message),
            );
            return;
          }

          /** @type {any} */
          let envelope;
          try {
            envelope = JSON.parse(stdout);
          } catch {
            reject(new Error(oneLine(stdout, 'Cursor Agent did not return JSON.')));
            return;
          }

          const resultText = typeof envelope?.result === 'string' ? envelope.result : '';
          if (envelope?.is_error) {
            reject(
              new Error(
                isCursorNotLoggedInError(resultText)
                  ? CURSOR_NOT_LOGGED_IN_MESSAGE
                  : oneLine(resultText, 'Cursor Agent reported an error.'),
              ),
            );
            return;
          }

          try {
            resolve(JSON.stringify(parseJSONMessage(resultText)));
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error(oneLine(resultText, 'Cursor Agent did not return valid JSON.')),
            );
          }
        });
      })
    );

  try {
    return await invokeCursor(model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (model === fallbackModel || !isCursorModelAvailabilityError(message)) {
      throw error;
    }

    const response = await invokeCursor(fallbackModel);
    await options.onModelFallback?.(fallbackModel, model);
    return response;
  }
};

module.exports = {
  CURSOR_MODELS,
  CURSOR_NOT_FOUND_CODE,
  CURSOR_NOT_FOUND_MESSAGE,
  DEFAULT_CURSOR_MODEL,
  FALLBACK_CURSOR_MODEL,
  getCursorCommand,
  isCursorModelAvailabilityError,
  isCursorNotFoundError,
  isCursorNotLoggedInError,
  normalizeCursorModel,
  runCursor,
};
