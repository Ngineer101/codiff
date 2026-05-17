const { execFile } = require('node:child_process');
const { promises: fs } = require('node:fs');
const { createHash } = require('node:crypto');
const { isAbsolute, join, normalize, sep } = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const getFingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);

const getGravatarHash = (email) =>
  createHash('md5').update(email.trim().toLowerCase()).digest('hex');

const git = async (repoPath, args, options = {}) => {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: options.encoding || 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

const gitBuffer = async (repoPath, args) => {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

const EAGER_TEXT_FILE_LIMIT = 256 * 1024;
const MANUAL_TEXT_FILE_LIMIT = 2 * 1024 * 1024;
const MAX_UNTRACKED_INITIAL_ITEMS = 1000;
const GENERATED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.next',
  '.parcel-cache',
  '.pnpm-store',
  '.turbo',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const generatedDirectoryPathspecExcludes = [...GENERATED_DIRECTORY_NAMES].flatMap((name) => [
  `:(exclude)${name}/**`,
  `:(exclude)**/${name}/**`,
]);

const generatedDirectoryPathspecs = [...GENERATED_DIRECTORY_NAMES].flatMap((name) => [
  name,
  `:(glob)**/${name}/`,
]);

const fileSort = (left, right) => {
  const leftParts = left.path.split('/');
  const rightParts = right.path.split('/');
  const length = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === rightPart) {
      continue;
    }

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return leftPart.localeCompare(rightPart);
  }

  return leftParts.length - rightParts.length;
};

const parseStatus = (raw) => {
  const parts = raw.split('\0').filter(Boolean);
  const files = new Map();

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    const x = record[0];
    const y = record[1];
    let path = record.slice(3);
    let oldPath;

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = parts[++index];
    }

    const current = files.get(path) || {
      oldPath,
      path,
      staged: false,
      status: 'modified',
      unstaged: false,
      untracked: false,
    };

    if (x === '?' && y === '?') {
      current.status = 'untracked';
      current.unstaged = true;
      current.untracked = true;
    } else {
      current.staged = x !== ' ';
      current.unstaged = y !== ' ';

      const statusCode = current.staged ? x : y;
      current.status =
        statusCode === 'A'
          ? 'added'
          : statusCode === 'D'
            ? 'deleted'
            : statusCode === 'R' || statusCode === 'C'
              ? 'renamed'
              : 'modified';
    }

    files.set(path, current);
  }

  return [...files.values()].sort(fileSort);
};

const isBinaryBuffer = (buffer) => buffer.includes(0);

const formatBytes = (size) => {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }

  return `${size} B`;
};

const createSummary = (reason, details = {}) => ({
  reason,
  ...details,
});

const validateRepositoryPath = (path) => {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path)) {
    throw new Error('Invalid repository path.');
  }

  const normalized = normalize(path);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error('Invalid repository path.');
  }

  return path;
};

const readFileStat = async (repoRoot, path) => {
  try {
    return await fs.lstat(join(repoRoot, path));
  } catch {
    return undefined;
  }
};

const getBlobSize = async (repoRoot, spec) => {
  try {
    return Number((await git(repoRoot, ['cat-file', '-s', spec])).trim());
  } catch {
    return undefined;
  }
};

const bufferToTextFile = (name, buffer, cacheKey) => {
  if (isBinaryBuffer(buffer)) {
    return {
      binary: true,
      file: undefined,
    };
  }

  return {
    binary: false,
    file: {
      cacheKey,
      contents: buffer.toString('utf8'),
      name,
    },
  };
};

const readGitFile = async (repoRoot, ref, path, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;
  const spec = `${ref}:${path}`;

  try {
    const size = await getBlobSize(repoRoot, spec);
    if (size != null && size > limit) {
      return {
        binary: false,
        loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(size)} and will be loaded on demand.`,
          {
            canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size,
          },
        ),
      };
    }

    const buffer = await gitBuffer(repoRoot, ['show', spec]);
    return bufferToTextFile(path, buffer, `${ref}:${path}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `${ref}:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

const readIndexFile = async (repoRoot, path, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;
  const spec = `:${path}`;

  try {
    const size = await getBlobSize(repoRoot, spec);
    if (size != null && size > limit) {
      return {
        binary: false,
        loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(size)} and will be loaded on demand.`,
          {
            canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size,
          },
        ),
      };
    }

    const buffer = await gitBuffer(repoRoot, ['show', spec]);
    return bufferToTextFile(path, buffer, `index:${path}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `index:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

const readWorkingTreeFile = async (repoRoot, path, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;

  try {
    const stat = await readFileStat(repoRoot, path);
    if (!stat) {
      throw new Error('File is missing.');
    }

    if (stat.isDirectory()) {
      return {
        binary: false,
        loadState: 'directory',
        summary: createSummary('Untracked directory is collapsed by default.', {
          canLoad: false,
        }),
      };
    }

    if (stat.isSymbolicLink()) {
      const contents = await fs.readlink(join(repoRoot, path));
      const size = Buffer.byteLength(contents);

      if (size > limit) {
        return {
          binary: false,
          loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
          summary: createSummary(
            size > MANUAL_TEXT_FILE_LIMIT
              ? `Symlink target is ${formatBytes(size)}, so Codiff skipped rendering it.`
              : `Symlink target is ${formatBytes(size)} and will be loaded on demand.`,
            {
              canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
              limit,
              size,
            },
          ),
        };
      }

      return {
        binary: false,
        file: {
          cacheKey: `worktree:${path}:symlink:${contents}`,
          contents,
          name: path,
        },
      };
    }

    if (!stat.isFile()) {
      return {
        binary: false,
        loadState: 'error',
        summary: createSummary('Path is not a regular file.', {
          canLoad: false,
          size: stat.size,
        }),
      };
    }

    if (stat.size > limit) {
      return {
        binary: false,
        loadState: stat.size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          stat.size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(stat.size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(stat.size)} and will be loaded on demand.`,
          {
            canLoad: stat.size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size: stat.size,
          },
        ),
      };
    }

    const buffer = await fs.readFile(join(repoRoot, path));
    return bufferToTextFile(path, buffer, `worktree:${path}:${buffer.length}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `worktree:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

const createPatchForNewFile = (path, contents) => {
  const trimmed = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  const lines = trimmed.length > 0 ? trimmed.split('\n') : [];
  const body = lines.map((line) => `+${line}`).join('\n');
  const noNewline = contents.endsWith('\n') ? '' : '\n\\ No newline at end of file';

  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ]
    .filter(Boolean)
    .join('\n')
    .concat(noNewline, '\n');
};

const getPatch = async (repoRoot, path, kind) => {
  const args =
    kind === 'staged'
      ? ['diff', '--cached', '--patch', '--no-ext-diff', '--', path]
      : ['diff', '--patch', '--no-ext-diff', '--', path];
  const patch = await git(repoRoot, args);

  return {
    binary: /Binary files .* differ/.test(patch),
    patch,
  };
};

const summarizeContent = (...results) => {
  const binary = results.some((result) => result.binary);
  if (binary) {
    return {
      binary: true,
      loadState: 'binary',
      summary: createSummary('Binary file changed.', {
        canLoad: false,
      }),
    };
  }

  const summaryResult = results.find((result) => result.loadState && result.loadState !== 'ready');
  if (summaryResult) {
    return {
      binary: false,
      loadState: summaryResult.loadState,
      summary: summaryResult.summary,
    };
  }

  return {
    binary: false,
    loadState: 'ready',
  };
};

const getWorkingTreeContents = async (repoRoot, item, kind, options = {}) => {
  if (kind === 'staged') {
    const oldFile = await readGitFile(repoRoot, 'HEAD', item.oldPath || item.path, options);
    const newFile = await readIndexFile(repoRoot, item.path, options);
    const summary = summarizeContent(oldFile, newFile);

    return {
      ...summary,
      newFile: newFile.file,
      oldFile: oldFile.file,
    };
  }

  if (item.untracked) {
    const newFile = item.summary
      ? {
          binary: false,
          loadState: item.summary.loadState,
          summary: item.summary,
        }
      : item.directory
        ? {
            binary: false,
            loadState: 'directory',
            summary: createSummary('Untracked directory is collapsed by default.', {
              canLoad: false,
            }),
          }
        : await readWorkingTreeFile(repoRoot, item.path, options);
    const summary = summarizeContent(newFile);

    return {
      ...summary,
      newFile: newFile.file,
      oldFile: {
        cacheKey: `empty:${item.path}`,
        contents: '',
        name: item.path,
      },
    };
  }

  const oldFile = await readIndexFile(repoRoot, item.oldPath || item.path, options);
  const newFile = await readWorkingTreeFile(repoRoot, item.path, options);
  const summary = summarizeContent(oldFile, newFile);

  return {
    ...summary,
    newFile: newFile.file,
    oldFile: oldFile.file,
  };
};

const createSection = async (repoRoot, item, kind, options = {}) => {
  const contents = await getWorkingTreeContents(repoRoot, item, kind, options);
  const id = `${item.path}:${kind}`;

  if (contents.loadState !== 'ready') {
    return {
      binary: contents.binary,
      id,
      kind,
      loadState: contents.loadState,
      patch: '',
      summary: contents.summary,
    };
  }

  if (item.untracked) {
    return {
      binary: false,
      id,
      kind,
      loadState: 'ready',
      newFile: contents.newFile,
      oldFile: contents.oldFile,
      patch: createPatchForNewFile(item.path, contents.newFile?.contents || ''),
    };
  }

  const patch = await getPatch(repoRoot, item.path, kind);

  return {
    binary: patch.binary || contents.binary,
    id,
    kind,
    loadState: 'ready',
    newFile: contents.newFile,
    oldFile: contents.oldFile,
    patch: patch.patch,
  };
};

const normalizeStatus = (statusCode) =>
  statusCode === 'A'
    ? 'added'
    : statusCode === 'D'
      ? 'deleted'
      : statusCode === 'R' || statusCode === 'C'
        ? 'renamed'
        : 'modified';

const parseCommitNameStatus = (raw) => {
  const parts = raw.split('\0').filter(Boolean);
  const files = [];

  for (let index = 0; index < parts.length; ) {
    const statusCode = parts[index++];
    const statusType = statusCode[0];

    if (statusType === 'R' || statusType === 'C') {
      const oldPath = parts[index++];
      const path = parts[index++];
      files.push({
        oldPath,
        path,
        status: 'renamed',
      });
    } else {
      const path = parts[index++];
      files.push({
        path,
        status: normalizeStatus(statusType),
      });
    }
  }

  return files.sort(fileSort);
};

const listUntrackedItems = async (repoRoot) => {
  const rawFiles = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    '.',
    ...generatedDirectoryPathspecExcludes,
  ]);
  const paths = rawFiles.split('\0').filter(Boolean).sort();
  const items = paths.slice(0, MAX_UNTRACKED_INITIAL_ITEMS).map((path) => ({
    path,
    staged: false,
    status: 'untracked',
    unstaged: true,
    untracked: true,
  }));

  if (paths.length > MAX_UNTRACKED_INITIAL_ITEMS) {
    const omitted = paths.length - MAX_UNTRACKED_INITIAL_ITEMS;
    items.push({
      directory: true,
      path: `Untracked files not shown (${omitted} more)`,
      staged: false,
      status: 'untracked',
      summary: createSummary(`${omitted} untracked files are not shown.`, {
        canLoad: false,
        fileCount: omitted,
        loadState: 'directory',
      }),
      unstaged: true,
      untracked: true,
    });
  }

  const rawDirectories = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--directory',
    '-z',
    '--',
    ...generatedDirectoryPathspecs,
  ]);

  for (const path of rawDirectories.split('\0').filter(Boolean)) {
    items.push({
      directory: true,
      path: path.endsWith('/') ? path.slice(0, -1) : path,
      staged: false,
      status: 'untracked',
      unstaged: true,
      untracked: true,
    });
  }

  const unique = new Map();
  for (const item of items) {
    unique.set(item.path, item);
  }

  return [...unique.values()].sort(fileSort);
};

const readWorkingTreeState = async (launchPath) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const [trackedStatus, untrackedItems] = await Promise.all([
    git(repoRoot, ['status', '--porcelain=v1', '-z', '-uno']),
    listUntrackedItems(repoRoot),
  ]);
  const status = [...parseStatus(trackedStatus), ...untrackedItems].sort(fileSort);
  const files = [];

  for (const item of status) {
    const sections = [];

    if (item.staged) {
      sections.push(await createSection(repoRoot, item, 'staged'));
    }

    if (item.unstaged) {
      sections.push(await createSection(repoRoot, item, 'unstaged'));
    }

    const fingerprint = getFingerprint(
      `${item.status}\n${item.oldPath || ''}\n${sections
        .map(
          (section) =>
            `${section.loadState || 'ready'}\n${section.binary ? 'binary' : 'text'}\n${
              section.patch
            }\n${section.summary?.reason || ''}\n${
              section.oldFile?.contents || ''
            }\n${section.newFile?.contents || ''}`,
        )
        .join('\n')}`,
    );

    files.push({
      fingerprint,
      oldPath: item.oldPath,
      path: item.path,
      sections,
      status: item.status,
    });
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      type: 'working-tree',
    },
  };
};

const getStatusItemForPath = async (repoRoot, path) => {
  const trackedStatus = parseStatus(
    await git(repoRoot, ['status', '--porcelain=v1', '-z', '-uno']),
  );
  const trackedItem = trackedStatus.find((item) => item.path === path);
  if (trackedItem) {
    return trackedItem;
  }

  const stat = await readFileStat(repoRoot, path);
  return {
    directory: Boolean(stat?.isDirectory()),
    path,
    staged: false,
    status: 'untracked',
    unstaged: true,
    untracked: true,
  };
};

const readDiffSectionContent = async (launchPath, request) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const path = validateRepositoryPath(request.path);
  if (request.kind === 'commit' || request.source?.type === 'commit') {
    throw new Error('Lazy loading commit diffs is not supported.');
  }

  const item = await getStatusItemForPath(repoRoot, path);
  return createSection(repoRoot, item, request.kind, {
    force: request.force,
  });
};

const readUntrackedFileSignatures = async (repoRoot) => {
  const raw = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--directory',
    '-z',
    '--',
    '.',
  ]);
  const paths = raw.split('\0').filter(Boolean).sort();
  const signatures = [];

  for (const path of paths) {
    try {
      const stat = await fs.lstat(join(repoRoot, path));
      signatures.push(`${path}\0${stat.size}\0${stat.mtimeMs}\0${stat.mode}`);
    } catch {
      signatures.push(`${path}\0missing`);
    }
  }

  return signatures.join('\0');
};

const gitOrEmpty = async (repoRoot, args) => {
  try {
    return await git(repoRoot, args);
  } catch {
    return '';
  }
};

const readGitIdentity = async (launchPath) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const [name, email] = await Promise.all([
    gitOrEmpty(repoRoot, ['config', '--get', 'user.name']),
    gitOrEmpty(repoRoot, ['config', '--get', 'user.email']),
  ]);
  const trimmedEmail = email.trim();

  return {
    email: trimmedEmail,
    gravatarUrl: trimmedEmail
      ? `https://www.gravatar.com/avatar/${getGravatarHash(trimmedEmail)}?s=80&d=identicon`
      : undefined,
    name: name.trim(),
  };
};

const readRepositoryChangeSignature = async (launchPath) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const [head, status, stagedDiff, unstagedDiff, untracked] = await Promise.all([
    gitOrEmpty(repoRoot, ['rev-parse', '--verify', 'HEAD']),
    git(repoRoot, ['status', '--branch', '--porcelain=v1', '-z', '-uno']),
    gitOrEmpty(repoRoot, ['diff', '--cached', '--binary', '--no-ext-diff']),
    gitOrEmpty(repoRoot, ['diff', '--binary', '--no-ext-diff']),
    readUntrackedFileSignatures(repoRoot),
  ]);

  return {
    root: repoRoot,
    signature: getFingerprint([head, status, stagedDiff, unstagedDiff, untracked].join('\0')),
  };
};

const readCommitState = async (launchPath, ref) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const commit = (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const status = parseCommitNameStatus(
    await git(repoRoot, [
      'diff-tree',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-z',
      '--root',
      '-M',
      commit,
    ]),
  );
  const files = [];

  for (const item of status) {
    const patch = await git(repoRoot, [
      'show',
      '--format=',
      '--patch',
      '--no-ext-diff',
      '--find-renames',
      commit,
      '--',
      item.path,
    ]);
    const oldFile = await readGitFile(repoRoot, `${commit}^`, item.oldPath || item.path);
    const newFile = await readGitFile(repoRoot, commit, item.path);

    files.push({
      fingerprint: getFingerprint(
        `${commit}\n${item.oldPath || ''}\n${patch}\n${oldFile.file?.contents || ''}\n${
          newFile.file?.contents || ''
        }`,
      ),
      oldPath: item.oldPath,
      path: item.path,
      sections: [
        {
          binary: /Binary files .* differ/.test(patch) || oldFile.binary || newFile.binary,
          id: `${item.path}:${commit}`,
          kind: 'commit',
          newFile: newFile.file,
          oldFile: oldFile.file,
          patch,
        },
      ],
      status: item.status,
    });
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      ref: commit,
      type: 'commit',
    },
  };
};

const readRepositoryState = async (launchPath, source = { type: 'working-tree' }) =>
  source.type === 'commit'
    ? readCommitState(launchPath, source.ref)
    : readWorkingTreeState(launchPath);

const listRepositoryHistory = async (launchPath, limit = 200) => {
  const repoRoot = (await git(launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const raw = await git(repoRoot, [
    'log',
    `--max-count=${limit}`,
    '--format=%H%x00%P%x00%ct%x00%s%x00',
  ]);
  const parts = raw.split('\0').filter(Boolean);
  const entries = [];

  for (let index = 0; index < parts.length; index += 4) {
    entries.push({
      committedAt: Number(parts[index + 2]) * 1000,
      parents: parts[index + 1] ? parts[index + 1].split(' ') : [],
      ref: parts[index],
      subject: parts[index + 3],
    });
  }

  return {
    entries,
    root: repoRoot,
  };
};

module.exports = {
  listRepositoryHistory,
  parseStatus,
  readDiffSectionContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readCommitState,
  readRepositoryState,
  readWorkingTreeState,
  validateRepositoryPath,
};
