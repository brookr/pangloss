# Pangloss

> *"All is for the best in this best of all possible worlds"* — Voltaire

Pangloss is a **multi-model fusion** code-generation system. It runs a diverse
roster of AI coding agents — different models, *and* different agentic harnesses
— in parallel, has them cross-review each other's work, and synthesizes the
**best of all possible worlds** into one result. It's a bespoke take on
[OpenRouter's Fusion](https://openrouter.ai/blog/announcements/fusion-beats-frontier/)
idea: a loop of diverse, sonnet-level and open-weight models can rival — and in
combination exceed — any single frontier model.

## How it works

Each run is a loop over four phases. Every agent works in its **own git
worktree** (isolated checkout + branch); agents run on the host, so each tool
uses its own existing auth.

```
feature request
   │
   ▼  PLAN        N models draft independently → a rotating synthesizer merges
   │              them into one canonical plan (+ optional human approval gate)
   ▼  CODE        each model implements the plan in its own worktree, runs the
   │              project's build + tests, iterates to green, commits
   ▼  REVIEW      every model reviews every implementation: score, novel ideas,
   │              gaps, what's still needed
   ▼  SELECT      weighted vote (self-reviews down-weighted) picks a winner and
   │              produces a revision brief (must-fix + ideas to graft + gaps)
   └──▶ if not converged: re-base every agent on the WINNING branch, turn the
        brief into a revision plan, and loop. Stop on convergence or round cap.
```

The payoff is the **cross-pollination**: even when several agents pass, the
review phase surfaces each one's unique good ideas, and the revision rounds graft
them into the kept winner.

## The roster — diversity is the product

Agents are `<tool> + <model>` pairs. The same model through two different
harnesses (e.g. Sonnet via claude-code vs. via codex→OpenRouter) genuinely
produces different work.

| Tool | How it's driven | Examples |
|---|---|---|
| **claude** | Claude Code CLI (`claude -p`) | `claude:sonnet`, `claude:opus` |
| **codex** | OpenAI Codex CLI (`codex exec`) | `codex:gpt-5` |
| **codex `--oss`** | local open-weight via Ollama | `oss:gpt-oss:120b` |
| **cursor** | Cursor Agent CLI (`cursor-agent -p`) | `cursor:claude-4.5-sonnet`, `cursor:kimi-k2.5` |
| **OpenRouter** | any OpenRouter model via codex's custom provider | `openrouter:qwen/qwen3-coder`, `openrouter:z-ai/glm-4.6` |
| **gemini** | Gemini CLI (`gemini -p`) | `gemini:gemini-2.5-pro` *(needs `GOOGLE_CLOUD_PROJECT`)* |

Drop any of these into a roster ad hoc (`--roster "openrouter:qwen/qwen3-coder,claude:sonnet,oss:gpt-oss:120b"`),
or use a named roster from `pangloss.config.json` (`open-weight-heavy`,
`frontier`, `sonnet-family`, `openrouter`, …).

## Quick start

```bash
yarn install
yarn build

# See the roster catalog and named rosters
node dist/cli.js agents

# Check that your roster's CLIs are installed/authed and preview invocations
node dist/cli.js doctor --roster open-weight-heavy

# Run on the current repo (interactive: asks for the change + approves the plan)
node dist/cli.js run

# Or fully unattended
node dist/cli.js run --non-interactive --yes \
  --roster "claude:sonnet,openrouter:qwen/qwen3-coder,oss:gpt-oss:120b" \
  --request "Add a slugify() utility with unit tests"
```

Artifacts for every run land under `.pangloss/runs/<run-id>/` (per-round
`plan.json`, `code-outcomes.json`, `reviews.json`, `selection.json`,
`summary.md`). The winning worktree is kept for inspection.

## CLI

| Command | Description |
|---|---|
| `pangloss run` | Plan → code → review → select (→ revise-loop). The default command. |
| `pangloss agents` | List configured rosters and agent presets. |
| `pangloss doctor [--roster …]` | Verify roster CLIs are installed/authed; preview invocations. |
| `pangloss models [--filter …]` | List OpenRouter model slugs usable as `openrouter:<slug>`. |
| `pangloss config` / `pangloss setup` | Generate `pangloss.config.json` / `.env`. |

Key `run` flags: `--roster <name|csv>`, `--request <text>`, `--rounds <n>`,
`--keep-worktrees`, `--timeout <min>`, `-y/--yes`, `--non-interactive`.

## Setup

**Requirements:** Node 20+, Git 2.5+, and the CLIs for whatever roster you use
(`claude`, `codex`, `cursor-agent`, `gemini`, `ollama`). Each tool authenticates
itself (OAuth/subscription or API key) — Pangloss runs them on the host, so no
keys need to be injected anywhere.

**OpenRouter** (optional, for the `openrouter:` lanes and the `openrouter`
roster): set `OPENROUTER_API_KEY` in `.env`. Discover model slugs with
`pangloss models`.

**Local open-weight** (the `oss:` lanes / `gptoss`): run `ollama` with the model
pulled (e.g. `ollama pull gpt-oss:120b`). Driven via `codex exec --oss`.

The agent behavior contract every model obeys inside its worktree lives in
[`.claude/skills/pangloss-worktree/SKILL.md`](.claude/skills/pangloss-worktree/SKILL.md)
and is injected into every agent's system prompt.

## Web apps: a Docker-isolated DB per agent

For targets that need a database (or other services), the **compose runtime**
gives every agent its *own* stack so they run in parallel — no host-port
collisions, and your source tree is never modified. Add a `compose` block to the
manifest pointing at the app's existing `docker-compose.yml`:

```jsonc
"manifest": {
  "setup": "pnpm install",
  "build": "pnpm build",
  "test":  "pnpm test",           // integration tests hit the DB
  "e2e":   "pnpm test:e2e:ci",    // optional; Playwright self-starts the app
  "compose": {
    "file": "docker-compose.yml",
    "dbService": "db",
    "dbPortBase": 5440,           // agent i gets 5440 + i
    "urlEnv": "DATABASE_URL",
    "urlTemplate": "postgres://test_user:test_password@localhost:{port}/test_db",
    "dbSetup": "pnpm db:rebuild"  // migrate + seed the fresh DB
  }
}
```

Per agent, Pangloss writes a **port-rewritten copy** of your compose (the source
is untouched), brings it up under a unique project name —
`docker compose -p pangloss-<run>-<agent>` — waits for the DB, runs `dbSetup`,
injects `DATABASE_URL`, then builds/tests/e2e's against that isolated stack and
tears it down (`down -v`). Agents still run on the **host** (so their CLI auth
just works); only the *runtime/DB* is containerized.

Run it from a clone you've dedicated to Pangloss (it makes its own worktrees +
branches there; your other clones stay free for manual work):

```bash
cd ~/projects/msi/technician-app-gamma
node /path/to/pangloss/dist/cli.js run \
  --non-interactive --yes --overnight \
  -c /path/to/pangloss/examples/technician-app.config.json \
  --roster "claude:sonnet,oss:gpt-oss:120b,openrouter:qwen/qwen3-coder" \
  --request "…your feature…"
```

`--overnight` is recommended here: heavy e2e + slow local models want no clock.
See [`examples/technician-app.config.json`](examples/technician-app.config.json).

## Development

```bash
yarn build       # tsc
yarn test        # jest
yarn lint        # eslint
yarn typecheck   # tsc --noEmit
```

## License

MIT
