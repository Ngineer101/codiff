// @ts-check

const { execFile } = require('node:child_process');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');

/**
 * @typedef {'vscode' | 'cursor' | 'zed'} CodiffEditor
 * @typedef {{args: Array<string>; command: string}} EditorCommand
 * @typedef {{repoPath?: string}} EditorCommandContext
 */

const DEFAULT_EDITOR = 'vscode';

/** @param {unknown} value @returns {CodiffEditor} */
const normalizeEditor = (value) =>
  value === 'cursor' || value === 'zed' || value === 'vscode' ? value : DEFAULT_EDITOR;

/** @param {NodeJS.Platform} platform @param {string} absolutePath @returns {Array<EditorCommand>} */
const getVscodeCommands = (platform, absolutePath) => {
  /** @type {Array<EditorCommand>} */
  const commands = [];

  for (const command of ['/opt/homebrew/bin/code', '/usr/local/bin/code', 'code']) {
    commands.push({
      args: ['-g', absolutePath],
      command,
    });
  }

  if (platform === 'darwin') {
    commands.push({
      args: ['-a', 'Visual Studio Code', absolutePath],
      command: 'open',
    });
  }

  return commands;
};

/** @param {NodeJS.Platform} platform @param {string} absolutePath @returns {Array<EditorCommand>} */
const getCursorCommands = (platform, absolutePath) => {
  /** @type {Array<EditorCommand>} */
  const commands = [];

  for (const command of [
    join(homedir(), '.local/bin/cursor'),
    '/opt/homebrew/bin/cursor',
    '/usr/local/bin/cursor',
    'cursor',
  ]) {
    commands.push({
      args: ['-g', absolutePath],
      command,
    });
  }

  if (platform === 'darwin') {
    commands.push({
      args: ['-a', 'Cursor', absolutePath],
      command: 'open',
    });
  }

  return commands;
};

/** @param {NodeJS.Platform} platform @param {string} absolutePath @returns {Array<EditorCommand>} */
const getZedCommands = (platform, absolutePath) => {
  /** @type {Array<EditorCommand>} */
  const commands = [];

  for (const command of ['/usr/local/bin/zed', '/opt/homebrew/bin/zed', 'zed']) {
    commands.push({
      args: [absolutePath],
      command,
    });
  }

  if (platform === 'darwin') {
    commands.push({
      args: ['-a', 'Zed', absolutePath],
      command: 'open',
    });
  }

  return commands;
};

/** @type {Record<CodiffEditor, (platform: NodeJS.Platform, absolutePath: string) => Array<EditorCommand>>} */
const EDITOR_COMMAND_BUILDERS = {
  cursor: getCursorCommands,
  vscode: getVscodeCommands,
  zed: getZedCommands,
};

/** @param {{getEditor?: () => CodiffEditor; getEditorCommand?: () => string; platform?: NodeJS.Platform; shell: import('electron').Shell}} options */
const createEditorOpener = ({
  getEditor = () => DEFAULT_EDITOR,
  getEditorCommand = () => '',
  platform = process.platform,
  shell,
}) => {
  /** @param {string} command */
  // Handles simple editor commands with quoted arguments. Keep this small unless
  // we need full shell-style escaping semantics.
  const parseEditorCommand = (command) =>
    command.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) ?? [];

  /** @param {string} command @param {ReadonlyArray<string>} args */
  const runEditorCommand = (command, args) =>
    new Promise((resolveCommand) => {
      execFile(command, args, { windowsHide: true }, (error) => resolveCommand(!error));
    });

  /**
   * @param {string} arg
   * @param {string} absolutePath
   * @param {EditorCommandContext} context
   */
  const replaceEditorPlaceholders = (arg, absolutePath, context) =>
    arg
      .replaceAll('{file}', absolutePath)
      .replaceAll('{repo}', context.repoPath || dirname(absolutePath));

  /**
   * @param {ReadonlyArray<string>} args
   * @param {string} absolutePath
   * @param {EditorCommandContext} context
   */
  const getCustomEditorArgs = (args, absolutePath, context) => {
    if (args.length === 0) {
      return [absolutePath];
    }

    const expandedArgs = args.map((arg) => replaceEditorPlaceholders(arg, absolutePath, context));
    return args.some((arg) => arg.includes('{file}'))
      ? expandedArgs
      : [...expandedArgs, absolutePath];
  };

  /** @param {string} absolutePath @param {EditorCommandContext} [context] @returns {Array<EditorCommand>} */
  const getEditorCommands = (absolutePath, context = {}) => {
    /** @type {Array<EditorCommand>} */
    const commands = [];
    const customEditor = process.env.CODIFF_EDITOR || getEditorCommand();
    if (customEditor) {
      const [command, ...args] = parseEditorCommand(customEditor);
      if (command) {
        commands.push({
          args: getCustomEditorArgs(args, absolutePath, context),
          command,
        });
      }
    } else {
      commands.push(
        ...EDITOR_COMMAND_BUILDERS[normalizeEditor(getEditor())](platform, absolutePath),
      );
    }

    if (platform === 'darwin') {
      commands.push({
        args: ['-t', absolutePath],
        command: 'open',
      });
    }

    return commands;
  };

  /** @param {string} absolutePath @param {EditorCommandContext} [context] */
  const openFileInEditor = async (absolutePath, context = {}) => {
    for (const { args, command } of getEditorCommands(absolutePath, context)) {
      if (await runEditorCommand(command, args)) {
        return;
      }
    }

    await shell.openPath(absolutePath);
  };

  return {
    getEditorCommands,
    openFileInEditor,
    normalizeEditor,
    parseEditorCommand,
  };
};

module.exports = { createEditorOpener, normalizeEditor };
