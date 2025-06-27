# Pangloss Project Context

## Project Overview

**Pangloss** is a parallel LLM code generation system that runs multiple AI CLI
agents simultaneously to generate code, then intelligently merges the best
solutions into a single optimal output. Named after Voltaire's character who
believes "all is for the best in this best of all possible worlds."

## Current Project Status

### ✅ **Completed Features**

1. **Core Architecture**
   - TypeScript CLI tool (`pangloss`) with Commander.js
   - Docker Compose orchestration for parallel agent execution
   - GitHub integration for branch management and PR creation
   - Result merging with composite scoring algorithms

2. **LLM CLI Integration**
   - **OpenAI Codex CLI**: `codex --model o3 --approval-mode full-auto --quiet`
   - **Claude Code CLI**: `claude --model sonnet -p "..." --output-format stream-json`
   - **Gemini CLI**: `gemini --model gemini-2.5-pro --prompt "..."`
   - All agents run in non-interactive mode for full automation

3. **Model Selection Support**
   - OpenAI: `codex-o3`, `codex-gpt4` (o3, gpt-4.1)
   - Anthropic: `claude-sonnet`, `claude-opus`, `claude-haiku`
   - Google: `gemini-pro`, `gemini-flash` (2.5-pro, 2.0-flash)

4. **Environment Management**
   - Complete `.env` file support with dotenv
   - Environment variable validation and helpful warnings
   - `pangloss setup` command to generate .env template

5. **Docker Configuration**
   - Alpine Linux base (lightweight, secure)
   - All CLI tools pre-installed in containers
   - Bash shell for maximum compatibility
   - Non-root user for security

### 🔄 **Current State**

- **Project Status**: Ready for testing - all core features implemented
- **Build Status**: TypeScript compiles successfully
- **Dependencies**: All packages installed via yarn (node_modules/ in .gitignore)
- **Git Status**: Repository should be initialized and ready for commits

## Architecture Details

### **File Structure**

```text
pangloss/
├── src/
│   ├── cli.ts              # Main CLI with dotenv support
│   ├── types.ts            # TypeScript interfaces
│   ├── config.ts           # Configuration management
│   ├── pangloss.ts         # Main orchestrator class
│   ├── docker-orchestrator.ts # Docker container management
│   └── result-merger.ts    # Intelligence merging algorithms
├── agent-runner-cli.js     # Node.js script that runs inside containers
├── agent.Dockerfile        # Alpine Linux container with all CLI tools
├── pangloss.config.json    # Default configuration
├── .env.example           # Environment template
├── package.json           # Dependencies and scripts
└── README.md              # Comprehensive documentation
```

### **Usage Flow**

```bash
# Setup
pangloss setup              # Create .env file
# Edit .env with API keys
pangloss config             # Generate config file

# Generate code
pangloss generate \
  --repo https://github.com/user/project \
  --feature "add-authentication" \
  --prompt "Add JWT auth with login/logout" \
  --agents "codex-o3,claude-sonnet,gemini-pro"
```

### **What Happens Under the Hood**

1. **Validation**: Check API keys and environment
2. **Docker Spawn**: Create containers for each selected agent
3. **Parallel Execution**: Each container:
   - Clones repo to unique branch (`repo/feature/agent-name`)
   - Runs CLI tool in non-interactive mode
   - Validates with tests, build, Playwright E2E
   - Commits and pushes changes
4. **Result Collection**: Gather metrics and scores from each agent
5. **Intelligent Merging**: Combine best solutions using configurable strategies
6. **PR Creation**: Create final branch and GitHub pull request

## Technical Implementation

### **CLI Commands**

- `pangloss generate` - Main code generation command
- `pangloss config` - Generate configuration file
- `pangloss setup` - Create .env template
- `pangloss --help` - Show all options

### **Environment Variables**

```bash
# Required
GITHUB_TOKEN=your_token

# LLM APIs (at least one required)
OPENAI_API_KEY=your_key
ANTHROPIC_API_KEY=your_key  
GEMINI_API_KEY=your_key

# Optional configuration  
PANGLOSS_DEFAULT_AGENTS=codex-o3,claude-sonnet,gemini-pro
PANGLOSS_TIMEOUT_MINUTES=30          # Updated default
PANGLOSS_MAX_PARALLEL_AGENTS=6       # Updated default
PANGLOSS_CONFIG_PATH=./pangloss.config.json
PANGLOSS_MERGE_STRATEGY=best_overall
```

### **Merge Strategies**

- `best_overall`: Take highest-scoring complete solution
- `best_per_file`: Combine best version of each file (placeholder)
- `composite`: Merge complementary features (placeholder)

## Known Issues & Next Steps

### 🛠️ **Ready for Implementation**

1. **Test Full Workflow**: Need to commit code and test with real repository
2. **Enhanced Merge Strategies**: Currently `best_per_file` and `composite`
   fall back to `best_overall`
3. **Error Handling**: Add better error recovery and retry logic
4. **Logging**: Add structured logging for debugging

### 🎯 **Immediate Next Actions**

**When opening this project for the first time:**

1. **Verify Setup**: Check if `yarn install` and `yarn run build` work
2. **Test CLI**: Run `node dist/cli.js --help` to verify basic functionality
3. **Environment Setup**: Test `node dist/cli.js setup` and `.env` generation
4. **Live Testing**: Try the full workflow with a real repository
5. **Docker Validation**: Ensure containers build and CLI tools work properly

**Priority Issues to Investigate:**

- Verify all CLI tools (Codex, Claude Code, Gemini) install correctly in Docker
- Test non-interactive modes work as expected
- Validate GitHub integration and branch/PR creation
- Check if merge strategies produce reasonable results

## Development Commands

```bash
# Setup (if node_modules missing)
yarn install                    # Install dependencies

# Development
yarn run build                  # Build TypeScript
yarn run dev <command>          # Run in development
yarn typecheck                  # Type checking only

# Testing CLI
node dist/cli.js --help         # Test CLI functionality
node dist/cli.js setup          # Generate .env template
node dist/cli.js config         # Generate config file

# Testing full workflow (once .env is configured)
node dist/cli.js generate \
  --repo https://github.com/user/test-repo \
  --feature "test-feature" \
  --prompt "Add a simple test feature"

# Docker testing (when ready for integration testing)
docker-compose up --build       # Test container builds
```

## Key Design Decisions

1. **CLI Tools over APIs**: Use official CLI tools (Codex, Claude Code, Gemini)
   for better integration
2. **Alpine Linux**: Lightweight, secure base for containers
3. **Bash compatibility**: Reliable shell for automation scripts
4. **TypeScript**: Type safety and better developer experience
5. **Docker isolation**: Complete environment separation for each agent
6. **GitHub-centric**: Use GitHub as coordination layer for branches and results

## Dependencies

### **Required CLI Tools**

- `@openai/codex` - OpenAI Codex CLI
- `@anthropic-ai/claude-code` - Claude Code CLI  
- `@google/gemini-cli` - Gemini CLI

### **System Requirements**

- Node.js 20+
- Docker & Docker Compose
- Git & GitHub CLI (`gh`)
- API keys for desired LLM providers

## Success Criteria

The system is complete when:

- ✅ CLI tool builds and runs
- ✅ Environment setup works smoothly
- ⏳ Docker containers build successfully
- ⏳ All CLI tools work in non-interactive mode
- ⏳ GitHub integration (branches, PRs) functions
- ⏳ At least basic merge strategy works
- ⏳ End-to-end workflow completes successfully

## Project Philosophy

Pangloss embodies the idea that by running multiple AI agents in parallel and
intelligently combining their results, we can achieve better outcomes than any
single agent alone. The system prioritizes automation, reliability, and ease of
use while maintaining security through proper isolation.

---

*This file should be updated as the project evolves. Next session should focus
on committing code and testing the full workflow.*
