// @ts-check

/**
 * @typedef {'codex' | 'claude' | 'opencode' | 'pi'} AgentSkillId
 * @typedef {{
 *   agentLabel: string;
 *   id: AgentSkillId;
 *   label: string;
 *   targets: ReadonlyArray<{sourceSubdir: string; targetSubdir: string}>;
 * }} AgentSkill
 */

/** @type {ReadonlyArray<AgentSkill>} */
const AGENT_SKILLS = Object.freeze([
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

/** @param {unknown} id @returns {AgentSkill | undefined} */
const getAgentSkill = (id) => AGENT_SKILLS.find((skill) => skill.id === id);

/** @returns {ReadonlyArray<AgentSkill>} */
const listAgentSkills = () => AGENT_SKILLS;

/**
 * @param {(skill: AgentSkill, browserWindow: import('electron').BaseWindow | undefined) => void} install
 * @returns {import('electron').MenuItemConstructorOptions}
 */
const buildInstallSkillMenuItem = (install) => ({
  label: 'Install Skill',
  submenu: AGENT_SKILLS.map((skill) => ({
    click: (_menuItem, browserWindow) => install(skill, browserWindow),
    label: skill.agentLabel,
  })),
});

module.exports = {
  AGENT_SKILLS,
  buildInstallSkillMenuItem,
  getAgentSkill,
  listAgentSkills,
};
