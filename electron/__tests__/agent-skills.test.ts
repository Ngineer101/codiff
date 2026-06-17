import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { buildInstallSkillMenuItem, getAgentSkill, listAgentSkills } =
  require('../agent-skills.cjs') as {
    buildInstallSkillMenuItem: (
      install: (skill: { id: string }, browserWindow: unknown) => void,
    ) => {
      label: string;
      submenu: Array<{
        click: (menuItem: unknown, browserWindow: unknown) => void;
        label: string;
      }>;
    };
    getAgentSkill: (id: unknown) =>
      | {
          agentLabel: string;
          id: string;
          label: string;
          targets: ReadonlyArray<{ sourceSubdir: string; targetSubdir: string }>;
        }
      | undefined;
    listAgentSkills: () => ReadonlyArray<{ id: string }>;
  };
const { createSkillInstaller } = require('../main/agent-skill.cjs') as {
  createSkillInstaller: (options: {
    app: {
      getPath: (name: string) => string;
      isPackaged: boolean;
    };
    dialog: {
      showMessageBox: (options: unknown) => Promise<void>;
    };
    root: string;
    skill: NonNullable<ReturnType<typeof getAgentSkill>>;
  }) => {
    getStatus: () => { installed: boolean; path: string };
    install: () => Promise<boolean>;
  };
};

test('lists every bundled skill with its installation target', () => {
  expect(listAgentSkills()).toEqual([
    {
      agentLabel: 'Codex',
      id: 'codex',
      label: 'Codex Skill',
      targets: [{ sourceSubdir: 'codex/skills/codiff', targetSubdir: '.codex/skills/codiff' }],
    },
    {
      agentLabel: 'Claude Code',
      id: 'claude',
      label: 'Claude Code Skill',
      targets: [{ sourceSubdir: 'claude/skills/codiff', targetSubdir: '.claude/skills/codiff' }],
    },
    {
      agentLabel: 'Pi',
      id: 'pi',
      label: 'Pi Skill',
      targets: [{ sourceSubdir: 'pi/skills/codiff', targetSubdir: '.pi/agent/skills/codiff' }],
    },
    {
      agentLabel: 'OpenCode',
      id: 'opencode',
      label: 'OpenCode Skill',
      targets: [
        {
          sourceSubdir: 'opencode/skills/codiff',
          targetSubdir: '.config/opencode/skills/codiff',
        },
      ],
    },
  ]);
});

test('builds an Install Skill submenu that routes each agent action', () => {
  const install = vi.fn();
  const menuItem = buildInstallSkillMenuItem(install);
  const browserWindow = {};

  expect(menuItem.label).toBe('Install Skill');
  expect(menuItem.submenu.map((item) => item.label)).toEqual([
    'Codex',
    'Claude Code',
    'Pi',
    'OpenCode',
  ]);

  menuItem.submenu[3].click({}, browserWindow);
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ id: 'opencode' }), browserWindow);
});

test('keeps skill instructions identical outside agent integration details', async () => {
  const paths = [
    'codex/skills/codiff/SKILL.md',
    'claude/skills/codiff/SKILL.md',
    'pi/skills/codiff/SKILL.md',
    'opencode/skills/codiff/SKILL.md',
  ];
  const documents = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  const normalized = documents.map((document) => {
    expect(document).toContain('   **Agent integration:**');
    return document.replace(
      /   \*\*Agent integration:\*\*[\s\S]*?\n\n/,
      '   **Agent integration:** <agent-specific>\n\n',
    );
  });

  expect(new Set(normalized).size).toBe(1);
});

test('installs the OpenCode skill into its global skills directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-opencode-skill-'));
  const home = join(directory, 'home');
  const root = join(directory, 'app');
  const source = join(root, 'opencode/skills/codiff');
  const target = join(home, '.config/opencode/skills/codiff');
  const skill = getAgentSkill('opencode');

  try {
    await mkdir(source, { recursive: true });
    expect(skill).toBeDefined();
    const installer = createSkillInstaller({
      app: {
        getPath: () => home,
        isPackaged: false,
      },
      dialog: {
        showMessageBox: async () => {},
      },
      root,
      skill: skill!,
    });

    await expect(installer.install()).resolves.toBe(true);
    expect(installer.getStatus()).toEqual({ installed: true, path: target });
    await expect(realpath(target)).resolves.toBe(await realpath(source));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
