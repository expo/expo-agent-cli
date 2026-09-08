// @ref llp/0006-agent-native-cli-surface.rfc.md §The `@expo/agent-cli` launcher, §Errors are prompts
// Shared contract of `@expo/agent-cli agents:setup`: what the command was asked to do, and what it did.

export interface SetupOptions {
  /** Agent ids from `--agent`, resolved the same way `@expo/agent-cli skills:sync` resolves them. */
  agents: string[];
  /** Maintain the managed block in the project's `AGENTS.md`. Disabled by `--no-agents-md`. */
  agentsMd: boolean;
  /** Link the agent skills of the installed packages. Disabled by `--no-agent-skills`. */
  agentSkills: boolean;
  /** Install official Expo plugins or skills. Disabled by --no-plugins. */
  plugins?: boolean;
  /** Accept the setup plan without prompting. */
  yes?: boolean;
  /** Install in the project instead of user home. Requires an Expo project. */
  project?: boolean;
  /** Print the report as one JSON object instead of the text summary. */
  json?: boolean;
}

/** What happened to the managed block. `skipped` means the file already held this exact block. */
export type AgentsMdAction = 'created' | 'updated' | 'skipped';

export interface AgentsMdResult {
  /** Project-relative path of the maintained file, always `AGENTS.md`. */
  path: string;
  action: AgentsMdAction;
}

export interface SetupSkillsResult {
  /** False only when the sync was skipped, which `--no-agent-skills` never reaches. */
  synced: boolean;
  /** Skills the installed packages ship. */
  discovered: number;
  /** Packages those skills come from. */
  packages: number;
  /** Agent ids the skills were linked for. */
  agents: string[];
  /** Project-relative directories the links live in, e.g. `[".claude/skills"]`. */
  skillsDirs: string[];
}

/** The whole answer of one `@expo/agent-cli agents:setup` run, and the shape `--json` prints. */
export interface SetupReport {
  projectRoot: string | null;
  scope: SetupScope;
  cancelled: boolean;
  plugins: PluginSetupResult[];
  errors: string[];
  /** Null when `--no-agent-skills` skipped the sync. */
  skills: SetupSkillsResult | null;
  /** Null when `--no-agents-md` skipped the file. */
  agentsMd: AgentsMdResult | null;
  /** Agent ids this run targeted, from the flags, the cached selection, or detection. */
  agents: string[];
  /** Things worth telling the user that are not failures, e.g. an unlinked `CLAUDE.md`. */
  notes: string[];
}

export type SetupScope = 'user' | 'project';

export interface InstallCommand {
  command: string;
  args: string[];
}

export interface AgentInstallPlan {
  agent: string;
  name: string;
  provider: 'claude' | 'codex' | 'skills';
  scope: SetupScope;
  destination: string;
  commands: InstallCommand[];
}

export interface PluginSetupResult {
  agent: string;
  provider: AgentInstallPlan['provider'];
  scope: SetupScope;
  destination: string;
  status: 'installed' | 'already-present' | 'failed';
  reason: string | null;
}
