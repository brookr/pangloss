export interface PanglossConfig {
  llm_presets: Record<string, LLMPreset>;
  default_agents: string[];
  github_token?: string;
  timeout_minutes: number;
  max_parallel_agents: number;
}

export interface LLMPreset {
  provider: 'openai' | 'anthropic' | 'google';
  model: string;
  cli_model?: string;  // Specific model flag for CLI tools
  temperature: number;
  max_tokens?: number;
  system_prompt?: string;
}

export interface AgentRequest {
  repo_url: string;
  feature_name: string;
  branch_name: string;
  llm_preset: LLMPreset;
  request_prompt: string;
  github_token: string;
}

export interface AgentResult {
  agent_id: string;
  branch_name: string;
  success: boolean;
  changes_made: string[];
  test_results?: TestResults;
  build_status: 'success' | 'failed' | 'not_run';
  playwright_results?: PlaywrightResults;
  metrics: AgentMetrics;
  error?: string;
}

export interface TestResults {
  passed: number;
  failed: number;
  total: number;
  coverage?: number;
  duration_ms: number;
}

export interface PlaywrightResults {
  passed: number;
  failed: number;
  total: number;
  screenshots: string[];
  duration_ms: number;
}

export interface AgentMetrics {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  complexity_score: number;
  quality_score: number;
  execution_time_ms: number;
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