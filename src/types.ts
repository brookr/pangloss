export interface PanglossConfig {
  llm_presets: Record<string, LLMPreset>;
  default_agents: string[];
  github_token?: string;
  timeout_minutes: number;
  max_parallel_agents: number;
  planner_agent?: string;
}

export interface LLMPreset {
  provider: 'openai' | 'anthropic' | 'google';
  model: string;
  cli_model?: string;  // Specific model flag for CLI tools
  temperature: number;
  max_tokens?: number;
  system_prompt?: string;
}

export type JobMode = 'generate' | 'judge' | 'finalize';

export interface PanglossPlan {
  summary: string;
  scope: string[];
  steps: string[];
  acceptance_criteria: string[];
  original_request: string;
  clarifications: QA[];
}

export interface QA {
  question: string;
  answer: string;
}

export interface PanglossRun {
  id: string; // YYYYMMDD-HHmmss-xxxx
  timestamp: string;
  repo_url: string;
  base_branch: string;
  agents: string[];
  plan: PanglossPlan;
  status: 'planning' | 'generating' | 'judging' | 'finalizing' | 'completed' | 'failed';
  results_dir: string;
}

export interface AgentRequest {
  run_id: string;
  agent_preset_id: string;
  repo_url: string;
  base_branch: string; // The branch to branch off from
  branch_name: string; // The branch to create/work on
  mode: JobMode;
  llm_preset: LLMPreset;
  plan: PanglossPlan;
  github_token: string;
  // For judge mode
  candidate_branches?: string[]; 
  // For finalize mode
  consolidated_recommendations?: string[];
}

export interface AgentResult {
  run_id: string;
  agent_id: string; // preset id
  branch_name: string;
  success: boolean;
  mode: JobMode;
  changes_made: string[];
  test_results?: TestResults;
  build_status: 'success' | 'failed' | 'not_run';
  metrics: AgentMetrics;
  error?: string;
  // Judge mode specific
  judgements?: AgentJudgement[];
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

export interface MergeStrategy {
  type: 'best_overall' | 'best_per_file' | 'composite';
  weights: {
    test_success: number;
    code_quality: number;
    performance: number;
    coverage: number;
  };
}
