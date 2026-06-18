import { AgentAdapter } from './agents/adapter.js';
import { WorktreeManager } from './worktree.js';
import { AcceptanceSuite, PanglossConfig, TargetManifest } from './types.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  phase(title: string): void;
  agent(id: string, msg: string): void;
}

/** Everything the phases need, assembled once by the orchestrator. */
export interface RunContext {
  config: PanglossConfig;
  manifest: TargetManifest;
  repoRoot: string;
  runId: string;
  /** Commit/branch the worktrees are cut from. */
  baseRef: string;
  /** The roster, in order. The synthesizer seat rotates across this list. */
  adapters: AgentAdapter[];
  worktrees: WorktreeManager;
  /** Absolute path to .pangloss/runs/<runId>. */
  runDir: string;
  logger: Logger;
  /** Whether we may prompt the user (TTY) for clarifications/approval. */
  interactive: boolean;
  /** Skip the human approval gate (CI / unattended runs). */
  autoApprove: boolean;
  /** The feature request text, if supplied non-interactively. */
  request?: string;
  /** Per-agent-invocation wall-clock cap. */
  timeoutMs: number;
  maxCodeIterations: number;
  /** Current round of the outer revise-loop; 0 for the first pass. */
  round: number;
  /** Max revise-loop rounds before stopping (loop also stops on convergence). */
  maxRounds: number;
  /**
   * The canonical acceptance suite (C₀) for this run, set by the acceptance
   * phase when the gate is enabled. Null when the gate is off.
   */
  acceptanceSuite: AcceptanceSuite | null;
}
