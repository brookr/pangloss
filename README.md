# Pangloss

> *"All is for the best in this best of all possible worlds"* - Voltaire

Pangloss is a parallel LLM code generation system that runs multiple AI CLI
agents simultaneously to generate code, then intelligently merges the best
solutions into a single optimal output.

## Features

- **Parallel Generation**: Runs multiple LLM CLI agents (Codex CLI, Claude
  Code, Gemini CLI) simultaneously
- **Intelligent Merging**: Combines the best aspects of each solution using
  configurable strategies
- **Docker Isolation**: Each agent runs in its own container with full
  environment setup
- **GitHub Integration**: Automatically creates branches, runs tests, and
  creates pull requests
- **Comprehensive Testing**: Includes build validation, unit tests, and
  Playwright E2E tests

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment variables
npm run dev setup    # Creates .env file from template
# Edit .env file and add your API keys

# Generate default configuration  
npm run dev config

# Generate code
npm run dev generate \
  --repo https://github.com/user/project \
  --feature "add-user-authentication" \
  --prompt "Add JWT-based user authentication with login/logout endpoints"
```

## Usage

### Basic Generation

```bash
pangloss generate \
  --repo https://github.com/user/project \
  --feature "feature-name" \
  --prompt "Detailed description of what to implement"
```

### Advanced Options

```bash
pangloss generate \
  --repo https://github.com/user/project \
  --feature "add-dark-mode" \
  --prompt "Add dark mode toggle to the UI with system preference detection" \
  --agents "codex-o3,claude-sonnet,gemini-pro" \
  --timeout 20 \
  --merge-strategy "best_per_file"
```

### Configuration

Pangloss uses a `pangloss.config.json` file for configuration:

```json
{
  "llm_presets": {
    "codex": {
      "provider": "openai",
      "model": "gpt-4",
      "temperature": 0.2,
      "system_prompt": "You are a precise code generator..."
    }
  },
  "default_agents": ["codex", "claude-sonnet"],
  "timeout_minutes": 15
}
```

## How It Works

1. **Agent Spawning**: Creates Docker containers for each LLM CLI agent
2. **Parallel Generation**: Each agent clones the repo and runs CLI tools in
   non-interactive mode:
   - **Codex CLI**: `--approval-mode full-auto --quiet` for complete
     automation
   - **Claude Code CLI**: `-p` with `--output-format stream-json` for headless
     mode
   - **Gemini CLI**: `--prompt` flag for non-interactive execution
3. **Validation**: Runs tests, builds, and Playwright E2E tests on each
   solution
4. **Intelligent Merging**: Combines the best solutions using configurable
   strategies
5. **PR Creation**: Creates a final branch and pull request with the optimal
   solution

## Merge Strategies

- **best_overall**: Takes the single best-performing solution
- **best_per_file**: Combines the best version of each modified file
- **composite**: Advanced merging that combines complementary features

## Branch Naming

Branches are created with the pattern: `{repo-name}/{feature-name}/{agent-name}`

Example:

- `my-app/add-auth/codex-o3`
- `my-app/add-auth/claude-sonnet`
- `my-app/add-auth/gemini-pro`
- `my-app/add-auth/final` (merged result)

## Requirements

- Node.js 20+
- Docker and Docker Compose
- Git and GitHub CLI (`gh`)
- CLI tools: OpenAI Codex CLI, Claude Code CLI, Gemini CLI
- API keys for desired LLM providers

## Environment Variables

Pangloss uses a `.env` file for configuration. Create one using:

```bash
# Generate .env template
node dist/cli.js setup

# Or manually create .env with:
GITHUB_TOKEN=your_github_personal_access_token
OPENAI_API_KEY=your_openai_api_key      # For Codex CLI
ANTHROPIC_API_KEY=your_anthropic_api_key # For Claude Code CLI
GEMINI_API_KEY=your_google_api_key       # For Gemini CLI
GOOGLE_API_KEY=your_google_api_key       # Alternative for Gemini CLI

# Optional configuration
PANGLOSS_DEFAULT_AGENTS=codex-o3,claude-sonnet,gemini-pro
PANGLOSS_TIMEOUT_MINUTES=15
PANGLOSS_CONFIG_PATH=./pangloss.config.json
```

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development mode
npm run dev

# Run tests
npm test

# Lint code
npm run lint
```

## Architecture

```text
┌─────────────────┐
│   Pangloss CLI  │
└─────────┬───────┘
          │
          ▼
┌─────────────────┐
│  Orchestrator   │
└─────────┬───────┘
          │
          ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Agent 1       │    │   Agent 2       │    │   Agent 3       │
│   (Docker)      │    │   (Docker)      │    │   (Docker)      │
│                 │    │                 │    │                 │
│ - Clone repo    │    │ - Clone repo    │    │ - Clone repo    │
│ - Generate code │    │ - Generate code │    │ - Generate code │
│ - Run tests     │    │ - Run tests     │    │ - Run tests     │
│ - Push branch   │    │ - Push branch   │    │ - Push branch   │
└─────────┬───────┘    └─────────┬───────┘    └─────────┬───────┘
          │                      │                      │
          ▼                      ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Result Merger                               │
│                                                                 │
│ - Analyze all solutions                                         │
│ - Score and rank results                                        │
│ - Merge best solutions                                          │
│ - Create final branch and PR                                    │
└─────────────────────────────────────────────────────────────────┘
```

## License

MIT License - see LICENSE file for details.
