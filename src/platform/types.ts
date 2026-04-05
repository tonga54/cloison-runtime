import type { Workspace, WorkspaceConfig } from "../workspace/types.js";
import type { SkillRegistry } from "../skills/registry.js";

export interface PlatformConfig {
  stateDir: string;
  skillsDir?: string;
  /** Default passphrase for credential encryption. Falls back to CLOISON_CREDENTIAL_KEY env var. */
  credentialPassphrase?: string;
}

export interface Platform {
  readonly stateDir: string;
  readonly skills: SkillRegistry;

  createWorkspace(
    userId: string,
    config?: Partial<WorkspaceConfig>,
  ): Promise<Workspace>;
  getWorkspace(userId: string): Promise<Workspace>;
  listWorkspaces(): Promise<string[]>;
  deleteWorkspace(userId: string): Promise<void>;
  workspaceExists(userId: string): Promise<boolean>;
}
