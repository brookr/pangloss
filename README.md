# Pangloss

> *"All is for the best in this best of all possible worlds"* - Voltaire

Pangloss is a parallel LLM code generation system that orchestrates multiple AI agents to solve coding tasks. It runs agents in parallel, has them cross-evaluate each other's work ("Judging"), selects the best solution, and then refines it based on peer recommendations ("Finalization").

## Features

- **Interactive Planning**: Collaborates with you to define a detailed implementation plan and acceptance criteria before writing any code.
- **Parallel Generation**: Runs multiple agents (Codex, Claude, etc.) simultaneously in isolated Docker containers to implement the plan.
- **Cross-Agent Judging**: Each agent reviews and scores every other agent's solution against the plan and test results.
- **Intelligent Selection**: Automatically picks the best solution based on weighted scores, test pass rates, and build status.
- **Automated Finalization**: Applies consolidated feedback from the judging phase to polish the winning solution.
- **Docker Isolation**: Full environment separation for every agent run.
- **Playwright Support**: Native support for E2E testing with Playwright.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Set up environment variables
npm run dev setup    # Creates .env file from template
# Edit .env file and add your API keys (GITHUB_TOKEN + at least one LLM key)

# Generate default configuration  
npm run dev config

# Start a new run (Interactive Mode)
# run this from the root of the git repo you want to modify
pangloss generate
```

## Setup

### Requirements

- Node.js 20+
- Docker and Docker Compose
- Git

### API Keys / Environment Variables

Pangloss needs:

- **GitHub**
  - `GITHUB_TOKEN` (required) — used for cloning/pushing branches.

- **LLM Provider Keys** (at least one)
  - `OPENAI_API_KEY` — required for `codex-*` agents.
  - `ANTHROPIC_API_KEY` — required for `claude-*` agents.
  - `GEMINI_API_KEY` — required for `gemini-*` agents (Gemini API key from https://aistudio.google.com/apikey).

Vertex AI (optional alternative for Gemini CLI):

- `GOOGLE_API_KEY`
- `GOOGLE_GENAI_USE_VERTEXAI=true`
- `GOOGLE_CLOUD_PROJECT=<your-gcp-project-id>`

### Using the `gemini-pro` agent

`gemini-pro` is available as an agent preset. To run it:

```bash
pangloss generate --agents "codex-o3,claude-sonnet,gemini-pro"
```

## Usage

### Interactive Mode (Recommended)

Simply run `pangloss generate` in your target repository. Pangloss will:
1. Detect your repository context.
2. Ask what change you want to make.
3. Ask clarifying questions to refine requirements.
4. Generate a detailed Plan for your approval.
5. Kick off the parallel generation -> judging -> finalization pipeline.

### Advanced Usage

```bash
# Skip planning by providing a pre-existing plan file
pangloss generate --plan-file ./my-plan.json

# Specify specific agents
pangloss generate --agents "codex-o3,claude-sonnet"

# Customize timeouts
pangloss generate --timeout 30

# Keep non-winning branches for inspection
pangloss generate --keep-branches
```

## Architecture

Pangloss executes a 4-phase pipeline for every run:

1.  **GENERATE**: $N$ agents run in parallel containers. Each clones the repo, creates a unique branch, implements the plan, writes tests, and pushes changes.
2.  **JUDGE**: $N$ agents run in parallel as judges. Each judge checks out every candidate branch, runs validation (build/test/e2e), and uses an LLM to score the solution and provide recommendations.
3.  **FINALIZE**: The system aggregates scores to pick a winner. A finalizer agent runs on the winning branch to apply consolidated recommendations from the judges and ensure all tests pass.
4.  **CLEANUP**: Non-winning branches are deleted from the remote (unless `--keep-branches` is used).

## Configuration

Pangloss uses `pangloss.config.json`. You can define custom LLM presets and default agents.

```json
{
  "llm_presets": {
    "codex-o3": { "provider": "openai", "model": "codex-cli", "cli_model": "o3", ... },
    "claude-sonnet": { "provider": "anthropic", "model": "claude-code-cli", ... }
  },
  "default_agents": ["codex-o3", "claude-sonnet"],
  "planner_agent": "claude-sonnet"
}
```

## Requirements

- Node.js 20+
- Docker and Docker Compose
- Git
- API Keys for GitHub and at least one LLM provider (OpenAI, Anthropic, and/or Gemini)

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
