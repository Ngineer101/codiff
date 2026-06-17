#!/usr/bin/env node

import { constants, cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { arch, homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (platform() !== 'darwin') {
  process.stderr.write('Local app installation is only supported on macOS.\n');
  process.exit(1);
}

const appName = 'Codiff.app';
const packageArch = arch();
const packagedAppPath = join(root, 'out', `Codiff-darwin-${packageArch}`, appName);
const installedAppPath = join(homedir(), 'Applications', appName);
const localBinDirectory = join(homedir(), '.local', 'bin');
const commandPath = join(localBinDirectory, 'codiff');
const helperPath = join(installedAppPath, 'Contents', 'Resources', 'app', 'bin', 'codiff-app');

if (!existsSync(packagedAppPath)) {
  process.stderr.write(`Could not find packaged app at ${packagedAppPath}.\n`);
  process.stderr.write(
    `Run \`electron-forge package --platform=darwin --arch=${packageArch}\` first.\n`,
  );
  process.exit(1);
}

mkdirSync(dirname(installedAppPath), { recursive: true });
mkdirSync(localBinDirectory, { recursive: true });

if (existsSync(commandPath)) {
  const commandStat = lstatSync(commandPath);

  if (!commandStat.isSymbolicLink()) {
    process.stderr.write(`${commandPath} already exists and is not a symlink.\n`);
    process.stderr.write('Move it out of the way before installing the local Codiff command.\n');
    process.exit(1);
  }

  rmSync(commandPath);
}

rmSync(installedAppPath, { force: true, recursive: true });
cpSync(packagedAppPath, installedAppPath, { recursive: true, verbatimSymlinks: true });

if (!existsSync(helperPath)) {
  process.stderr.write(`Could not find packaged terminal helper at ${helperPath}.\n`);
  process.exit(1);
}

symlinkSync(helperPath, commandPath);

process.stdout.write(`Installed Codiff.app to ${installedAppPath}\n`);
process.stdout.write(`Linked codiff to ${commandPath}\n`);

const pathEntries = (process.env.PATH || '').split(':').filter(Boolean);
const realCommandPath = await realpath(commandPath);
let activeCodiffPath = '';

for (const pathEntry of pathEntries) {
  const candidate = join(pathEntry, 'codiff');

  try {
    await access(candidate, constants.X_OK);
    activeCodiffPath = candidate;
    break;
  } catch {
    // Keep checking PATH entries.
  }
}

if (!pathEntries.includes(localBinDirectory)) {
  process.stdout.write(`Add ${localBinDirectory} to PATH to use the installed command.\n`);
} else if (
  activeCodiffPath &&
  (await realpath(activeCodiffPath).catch(() => '')) !== realCommandPath
) {
  process.stdout.write(`Note: PATH currently resolves codiff to ${activeCodiffPath}.\n`);
}
