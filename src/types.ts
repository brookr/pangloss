// ===========================================================================
// Pangloss type model
//
// The live (worktree-based) pipeline uses the "Agent*" + phase types below.
// A handful of legacy types (JobMode, TestResults, AgentMetrics,
// AgentJudgement, AgentResult) are retained because the legacy
// result-aggregator + its unit test still exercise them; they will be folded
// into the selection phase in a later slice.
// ===========================================================================

// ---------------------------------------------------------------------------
// Agent tooling
// ---------------------------------------------------------------------------

/** Which frontier-lab CLI drives a given agent. */
export type AgentTool = 'claude' | 'codex' | 'cursor' | 'gemini';

/** What an agent is being asked to do in a phase. */
export type AgentMode = 'plan' | 'synthesize' | 'code' | 'review';

/**
 * A fully-resolved agent the orchestrator can run. The combination of `tool`
 * + `model` (+ `oss`) is what produces model *diversity* — the whole point of
 * Pangloss. Two presets may share a tool but differ in model, or share a model
 * but differ in tool.
 */
export interface AgentPreset {
  /** Stable id used in rosters, branch names, and artifacts. */
  id: string;
  /** The CLI that backs this agent. */
  tool: AgentTool;
  /** Model flag passed to the CLI (`-m`/`--model`). For oss codex this is the ollama tag. */
  model: string;
  /** Human-friendly label, e.g. "gpt-oss:120b (local)". */
  label?: string;
  /** codex only: route through a local open-weight provider (`--oss`). */
  oss?: boolean;
  /** Local provider for `--oss` (default: ollama). */
  localProvider?: 'ollama' | 'lmstudio';
  /**
   * codex only: route through OpenRouter's OpenAI-compatible API (needs
   * OPENROUTER_API_KEY). `model` is then an OpenRouter slug, e.g.
   * "qwen/qwen3-coder". Gives the full agentic loop for any OpenRouter model.
   */
  openrouter?: boolean;
  /** True when this agent runs entirely on the local machine (no cloud calls). */
  local?: boolean;
  /** Optional persona appended to prompts to widen behavioral diversity. */
  persona?: string;
  /** Per-agent wall-clock cap (minutes) for a single model invocation. Overrides the tier default. */
  timeoutMinutes?: number;
}

// ---------------------------------------------------------------------------
// Target manifest — how to validate the repo under test
// ---------------------------------------------------------------------------

/**
 * Describes how to set up, build, test, and (optionally) run the target repo.
 * This is the single seam that lets Pangloss validate *any* project: for the
 * dogfood target it's yarn install/build/test; for a web app it additionally
 * carries `start` + `e2e` + a port range so each worktree gets an isolated
 * running instance.
 */
export interface TargetManifest {
  /** Install dependencies (run once per worktree before coding). */
  setup?: string;
  /** Build / typecheck command; non-zero exit = build failed. */
  build?: string;
  /** Unit/integration test command. */
  test?: string;
  /** Optional end-to-end command (e.g. Playwright). */
  e2e?: string;
  /**
   * Directory (relative to the repo root) where the spec-derived acceptance
   * suite lives. Defaults to "acceptance". Agents may refine these tests, but
   * weakening them is detected and penalized (see the acceptance phase/audit).
   */
  acceptanceDir?: string;
  /**
   * Command that runs ONLY the acceptance suite and prints a parseable summary
   * (e.g. `npx jest acceptance --silent`). When set, Pangloss generates the
   * suite from the plan's acceptance_criteria and uses pass-rate-against-the-
   * canonical-suite as the primary selection signal. When unset, the acceptance
   * gate is disabled and the pipeline behaves exactly as before.
   */
  acceptanceCmd?: string;
  /** Optional long-running app start command (backgrounded for E2E). */
  start?: string;
  /** First port handed to worktree 0; subsequent worktrees get base + index*offset. */
  portBase?: number;
  /** Spacing between per-worktree port allocations. */
  portOffset?: number;
  /**
   * When set, each agent gets its OWN isolated Docker Compose stack (e.g. a
   * per-agent Postgres) so N agents run in parallel without host-port collisions.
   * Pangloss generates a port-rewritten copy of `file` and brings it up under a
   * unique project name; your source compose is never modified.
   */
  compose?: ComposeConfig;
}

export interface ComposeConfig {
  /** Path to the target's docker-compose.yml (absolute, or relative to the repo root). */
  file: string;
  /** Service whose published port gets remapped per agent (default: "db"). */
  dbService?: string;
  /** Container-side DB port to publish (default: 5432). */
  dbContainerPort?: number;
  /** Host port assigned to agent 0; agent i gets dbPortBase + i (default: 5440). */
  dbPortBase?: number;
  /** Env var the app reads for its DB connection (e.g. "DATABASE_URL"). */
  urlEnv?: string;
  /** Connection-string template; `{port}` is replaced with the agent's host port. */
  urlTemplate?: string;
  /** Command to migrate + seed the fresh DB (run with `urlEnv` set, in the worktree). */
  dbSetup?: string;
  /** How long to wait for the DB to accept connections before giving up (ms; default 60000). */
  readyTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PanglossConfig {
  /** All known agents, keyed by id. */
  agent_presets: Record<string, AgentPreset>;
  /** Named rosters: a list of preset ids to run together. */
  rosters: Record<string, string[]>;
  /** Roster used when `--roster`/`--agents` is not supplied. */
  default_roster: string;
  /**
   * Order in which agents take the "synthesizer" seat across rounds, so no
   * single model's taste dominates the canonical plan. Defaults to roster order.
   */
  synth_rotation?: string[];
  /** How to validate the target repo. */
  manifest: TargetManifest;
  /** Max agents to run concurrently on the host. */
  max_parallel_agents: number;
  /** Default wall-clock cap (minutes) per *cloud* agent invocation. */
  total_timeout_minutes: number;
  /** Default wall-clock cap (minutes) for *local* (oss) agents — they can be much slower. */
  local_timeout_minutes: number;
  /** Max code/iterate loops an agent may take in the code phase. */
  max_code_iterations: number;
  /** Max outer revise-loop rounds (round 0 = first pass). Loop stops earlier on convergence. */
  max_rounds: number;
  /** Max retries per model call on transient/rate-limit (429) failures (exponential backoff). */
  max_retries: number;
  /**
   * Establish a project conventions guide (Phase 0) from documented conventions +
   * git-history patterns, cached under .pangloss/, and feed it to every phase.
   * Default true; set false for throwaway targets (e.g. benchmark clones).
   */
  conventions?: boolean;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface QA {
  question: string;
  answer: string;
}

export interface PanglossPlan {
  summary: string;
  /** Files or components expected to change. */
  scope: string[];
  /** Ordered implementation steps. */
  steps: string[];
  /** Testable criteria, including any E2E scenarios. */
  acceptance_criteria: string[];
  /** The original natural-language request. */
  original_request: string;
  clarifications: QA[];
  /** Which agent synthesized this canonical plan (set in the plan phase). */
  synthesized_by?: string;
  /** Round number, for the outer revise-loop (slice 2). */
  round?: number;
}

// ---------------------------------------------------------------------------
// Acceptance gate — spec-derived, mutable-but-audited tests
// ---------------------------------------------------------------------------

/** The project conventions guide (Phase 0), consumed by every later phase. */
export interface Conventions {
  /** The whole guide — injected into code + review prompts. */
  full: string;
  /** The headline rules only — injected into the (token-sensitive) plan prompt. */
  condensed: string;
}

/** One acceptance-test file: path relative to the repo root + its contents. */
export interface AcceptanceFile {
  path: string;
  content: string;
}

/** The canonical acceptance suite (C₀) generated from the plan's criteria. */
export interface AcceptanceSuite {
  files: AcceptanceFile[];
  /** acceptance_criteria each file/test is meant to cover (for traceability). */
  criteria: string[];
  /** Was each test confirmed to FAIL on the base code (non-vacuous)? */
  redOnBase: boolean;
}

/**
 * Per-lane audit of how an implementation fared against the acceptance contract,
 * and whether the lane's edits to the tests strengthened or weakened it. The
 * trustworthy signal is `passedVsCanonical` — the lane's implementation graded
 * against the ORIGINAL C₀, regardless of what the lane did to its own copy.
 */
export interface AcceptanceAudit {
  /** Size of the canonical suite C₀. */
  total: number;
  /** Lane's implementation vs the ORIGINAL canonical suite (the real bar). */
  passedVsCanonical: number;
  /** Lane's implementation vs its own (possibly modified) suite. */
  passedVsModified: number;
  /** Did the lane edit the acceptance tests at all? */
  modified: boolean;
  /** Objective weakening: passes its own suite but fails the canonical bar, or removed/loosened assertions. */
  weakened: boolean;
  /** clean = untouched; clarified = edited but still meets canonical; weakened = moved the goalposts. */
  verdict: 'clean' | 'clarified' | 'weakened';
  /** Human-readable explanation + any notable diff signals. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Live pipeline outcomes
// ---------------------------------------------------------------------------

/** What an agent reports after attempting to implement the plan in its worktree. */
export interface CodeOutcome {
  agentId: string;
  branch: string;
  worktreePath: string;
  done: boolean;
  summary: string;
  remainingWork: string[];
  build: { passed: boolean };
  tests: { passed: number; failed: number; total: number };
  filesChanged: string[];
  diffStat?: string;
  notesForReviewers: string[];
  /** Acceptance-gate audit, when the gate is enabled (manifest.acceptanceCmd set). */
  acceptance?: AcceptanceAudit;
  durationMs: number;
  error?: string;
}

/** One reviewer's structured assessment of one candidate implementation. */
export interface ReviewFinding {
  /** Agent doing the reviewing. */
  reviewer: string;
  /** Agent whose implementation is under review. */
  candidate: string;
  candidateBranch: string;
  /** 0-100 overall. */
  overallScore: number;
  meetsAcceptanceCriteria: boolean;
  subScores: {
    correctness: number;
    completeness: number;
    code_quality: number;
    test_quality: number;
    maintainability: number;
  };
  /** Genuinely novel, sound ideas in this candidate worth preserving. */
  novelIdeas: string[];
  /** What this candidate missed. */
  gaps: string[];
  /** What is still needed to fully satisfy the plan. */
  stillNeeded: string[];
  mustFix: string[];
  /**
   * The reviewer's read on any changes this candidate made to the acceptance
   * tests (present only when the gate is on). The objective audit drives
   * selection; this is the human-taste annotation that corroborates it.
   */
  acceptanceTests?: {
    verdict: 'clean' | 'clarified' | 'weakened' | 'unsure';
    note: string;
  };
  /** 0..1 self-assessed confidence. */
  confidence: number;
}

/** The "best of all possible worlds" decision + the brief that seeds the next round. */
export interface SelectionOutcome {
  winnerAgentId: string;
  winnerBranch: string;
  winnerWorktree: string;
  score: number;
  reason: string;
  /** Consolidated guidance for revising the winner — the seam the outer loop attaches to. */
  revisionBrief: {
    mustFix: string[];
    /** Novel ideas worth grafting in from non-winning candidates. */
    adoptFromOthers: string[];
    stillNeeded: string[];
  };
  scoreboard: { agentId: string; branch: string; score: number; meets: boolean }[];
}

// ===========================================================================
// Legacy types (retained for result-aggregator + its unit test)
// ===========================================================================

export type JobMode = 'generate' | 'judge' | 'finalize';

export interface TestResults {
  passed: number;
  failed: number;
  total: number;
  coverage?: number;
  duration_ms: number;
  e2e_passed?: number;
  e2e_failed?: number;
}

export interface AgentMetrics {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  complexity_score: number;
  quality_score: number;
  execution_time_ms: number;
  iterations?: number;
}

export interface AgentJudgement {
  candidate_branch: string;
  judge_preset: string;
  overall_score: number;
  sub_scores: {
    correctness: number;
    completeness: number;
    code_quality: number;
    test_quality: number;
    maintainability: number;
  };
  validation: {
    build_passed: boolean;
    unit_tests_passed: number;
    unit_tests_failed: number;
    e2e_tests_passed: number;
    e2e_tests_failed: number;
  };
  recommendations: {
    must_fix: string[];
    nice_to_have: string[];
  };
  confidence: number;
  violation: boolean;
}

export interface AgentResult {
  run_id: string;
  agent_id: string;
  branch_name: string;
  success: boolean;
  mode: JobMode;
  changes_made: string[];
  test_results?: TestResults;
  build_status: 'success' | 'failed' | 'not_run';
  metrics: AgentMetrics;
  error?: string;
  judgements?: AgentJudgement[];
}
