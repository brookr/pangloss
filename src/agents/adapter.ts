import { spawn } from 'child_process';
import { AgentMode, AgentPreset } from '../types.js';

export interface AdapterRunOpts {
  mode: AgentMode;
  /** The user/task content. Read-only modes should ask for a JSON block back. */
  prompt: string;
  /** Working directory: the main repo for plan/synthesize, the worktree for code/review. */
  cwd: string;
  /**
   * System/contract text (worktree contract + persona). For Claude this is
   * passed via --append-system-prompt; for tools without a system flag it is
   * prepended to the prompt.
   */
  system?: string;
  /** Override the adapter's own per-agent timeout for this call. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Streamed stdout/stderr for live logging. */
  onLog?: (chunk: string) => void;
  /** Called once per retry with a short human message. */
  onRetry?: (msg: string) => void;
}

export interface AdapterRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Exited 0 but produced no output — a silently-broken lane (cursor/gemini headless). */
  emptyOutput?: boolean;
  /** Rough token proxy ((prompt+output chars)/4) — text-mode CLIs expose no usage; good enough for relative cost. */
  approxTokens?: number;
  /** How many attempts were made (1 = succeeded/failed first try). */
  attempts?: number;
}

interface Invocation {
  command: string;
  args: string[];
  /** When true the prompt is written to the child's stdin; otherwise it is already in args. */
  promptOnStdin: boolean;
}

/**
 * Wraps a single frontier-lab CLI behind one interface so the orchestrator can
 * treat Claude, Codex (cloud + local --oss), Cursor, and Gemini identically.
 * Each tool's verified non-interactive invocation, autonomy flags, and
 * read-only vs. write posture live here and nowhere else.
 */
export class AgentAdapter {
  /**
   * @param timeoutMs per-agent wall-clock cap for a single model invocation.
   *   Resolved by the orchestrator from the preset / tier defaults so that slow
   *   local models get a longer leash than fast cloud ones.
   */
  constructor(
    public readonly preset: AgentPreset,
    public timeoutMs: number = 30 * 60_000,
    /** Max retries on transient/rate-limit failures (free OpenRouter tiers 429 a lot). */
    public maxRetries: number = 5,
    /** Base for exponential backoff (ms); doubled each attempt, jittered, capped. */
    public retryBaseMs: number = 2_000
  ) {}

  get id(): string {
    return this.preset.id;
  }

  get label(): string {
    return this.preset.label ?? this.preset.id;
  }

  /** Whether this mode is allowed to modify files. Only `code` writes. */
  private writable(mode: AgentMode): boolean {
    return mode === 'code';
  }

  /**
   * Compose the prompt actually sent to the tool. Claude carries `system`
   * out-of-band (a flag); every other tool gets it prepended so the contract
   * still binds.
   */
  private composePrompt(opts: AdapterRunOpts): string {
    if (this.preset.tool === 'claude' || !opts.system) return opts.prompt;
    return `${opts.system}\n\n---\n\n${opts.prompt}`;
  }

  /** Build the exact command line for a run. Exposed for dry-run / doctor. */
  buildInvocation(opts: AdapterRunOpts): Invocation {
    const { preset } = this;
    const writable = this.writable(opts.mode);
    const promptText = this.composePrompt(opts);

    switch (preset.tool) {
      case 'claude': {
        // `--output-format text` prints the model's final answer directly. (json
        // wraps it in a result envelope, which hides the JSON we ask agents for.)
        const args = ['-p', '--model', preset.model, '--output-format', 'text'];
        if (opts.system) args.push('--append-system-prompt', opts.system);
        args.push('--add-dir', opts.cwd);
        if (writable) {
          args.push('--permission-mode', 'bypassPermissions');
          // Eval guard: when set (e.g. by the SWE-bench harness), deny the agent
          // any way to fetch the upstream fix — web tools and network shells.
          if (process.env.PANGLOSS_NO_WEB === '1') {
            args.push(
              '--disallowedTools',
              'WebSearch',
              'WebFetch',
              'Bash(curl:*)',
              'Bash(wget:*)',
              'Bash(gh:*)',
              'Bash(git fetch:*)',
              'Bash(git pull:*)'
            );
          }
        } else {
          // Read-only posture: only pre-approve inspection tools.
          args.push(
            '--allowedTools',
            'Read',
            'Grep',
            'Glob',
            'Bash(git diff:*)',
            'Bash(git log:*)',
            'Bash(git show:*)',
            'Bash(cat:*)',
            'Bash(ls:*)'
          );
        }
        return { command: 'claude', args, promptOnStdin: true };
      }

      case 'codex': {
        // NOTE: codex MCP servers add seconds to every `codex exec` (and hold
        // stdio pipes open past SIGKILL). They can't be cleared via `-c` (codex
        // merges the table), so MCP is disabled in ~/.codex/config.toml instead.
        // Bump codex's INTERNAL retries (these honor the provider's 429 /
        // Retry-After headers, which we can't see from out here); our outer
        // retry wrapper backs this up with exponential backoff.
        const args = ['exec', '-c', 'request_max_retries=4', '-c', 'stream_max_retries=6'];
        if (preset.openrouter) {
          // Point codex at OpenRouter's OpenAI-compatible endpoint via config
          // overrides. Values are parsed as TOML, so strings must be quoted.
          args.push(
            '-c',
            'model_provider="openrouter"',
            '-c',
            'model_providers.openrouter.name="OpenRouter"',
            '-c',
            'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
            '-c',
            'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
            '-c',
            'model_providers.openrouter.wire_api="responses"',
            // Frugality: cap reasoning effort (the user's global codex config may
            // default to xhigh, which inflates token usage on paid OpenRouter).
            '-c',
            `model_reasoning_effort="${opts.mode === 'code' ? 'medium' : 'low'}"`
          );
        }
        args.push('-m', preset.model);
        if (preset.oss) {
          args.push('--oss', '--local-provider', preset.localProvider ?? 'ollama');
        }
        args.push('-s', writable ? 'workspace-write' : 'read-only');
        args.push('--skip-git-repo-check');
        // Prompt read from stdin via the `-` sentinel.
        args.push('-');
        return { command: 'codex', args, promptOnStdin: true };
      }

      case 'cursor': {
        // NOTE: `--mode ask`/`--mode plan` keep cursor-agent open in a Q&A wait
        // and never terminate under -p. Use plain -p (which prints once and
        // exits); add --force only for write-capable code mode. Read-only intent
        // is carried by the prompt + enforced by the worktree boundary check.
        const args = ['-p', '--output-format', 'text', '--model', preset.model, '--workspace', opts.cwd, '--trust'];
        if (writable) args.push('--force');
        args.push(promptText);
        return { command: 'cursor-agent', args, promptOnStdin: false };
      }

      case 'gemini': {
        const args = ['-m', preset.model, '-o', 'text'];
        args.push('--approval-mode', writable ? 'yolo' : 'plan');
        args.push('-p', promptText);
        return { command: 'gemini', args, promptOnStdin: false };
      }

      default: {
        // Exhaustiveness guard.
        const _never: never = preset.tool;
        throw new Error(`Unsupported tool: ${String(_never)}`);
      }
    }
  }

  /** Human-readable preview of the command (secrets are never in argv here). */
  previewCommand(opts: AdapterRunOpts): string {
    const inv = this.buildInvocation(opts);
    const shown = inv.promptOnStdin ? [...inv.args, '< <prompt-on-stdin>'] : inv.args;
    return `${inv.command} ${shown.map((a) => (a.length > 60 ? a.slice(0, 57) + '…' : a)).join(' ')}`;
  }

  private runOnce(opts: AdapterRunOpts): Promise<AdapterRunResult> {
    const inv = this.buildInvocation(opts);
    const promptText = this.composePrompt(opts);
    const start = Date.now();

    return new Promise((resolve) => {
      const child = spawn(inv.command, inv.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, CI: 'true', PANGLOSS_AGENT: this.id },
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group so a timeout can kill the whole tree (codex spawns
        // children that otherwise keep stdio pipes open past a plain kill).
        detached: true
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const killTree = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      };

      // A timeout of 0 (or less) means unlimited — for overnight runs with slow
      // local models that need as much time as they want.
      const effectiveTimeout = opts.timeoutMs ?? this.timeoutMs;
      const timer =
        effectiveTimeout > 0
          ? setTimeout(() => {
              timedOut = true;
              killTree();
            }, effectiveTimeout)
          : null;

      child.stdout.on('data', (d: Buffer) => {
        const s = d.toString();
        stdout += s;
        opts.onLog?.(s);
      });
      child.stderr.on('data', (d: Buffer) => {
        const s = d.toString();
        stderr += s;
        opts.onLog?.(s);
      });

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const okExit = code === 0 && !timedOut;
        const empty = stdout.trim().length === 0;
        resolve({
          // A lane that exits 0 but says nothing is NOT a success — it's a
          // silently-broken lane that would otherwise vanish from the fusion.
          ok: okExit && !empty,
          emptyOutput: okExit && empty,
          approxTokens: Math.ceil((promptText.length + stdout.length) / 4),
          stdout,
          stderr,
          code,
          timedOut,
          durationMs: Date.now() - start
        });
      };

      child.on('error', (err) => {
        stderr += `\n[spawn error] ${err instanceof Error ? err.message : String(err)}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));

      if (inv.promptOnStdin && child.stdin) {
        child.stdin.write(promptText);
        child.stdin.end();
      } else if (child.stdin) {
        child.stdin.end();
      }
    });
  }

  /**
   * Run with retry. On a transient/rate-limit failure (very common on free
   * OpenRouter tiers — HTTP 429 / "high demand" / stream resets), back off
   * exponentially with jitter — honoring any "retry after N" hint in the
   * output — and retry up to maxRetries. Rate-limit failures occur before any
   * work is done, so retrying is safe. A wall-clock timeout is NOT retried.
   */
  async run(opts: AdapterRunOpts): Promise<AdapterRunResult> {
    let last: AdapterRunResult = {
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      timedOut: false,
      durationMs: 0
    };
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      last = await this.runOnce(opts);
      if (last.ok || attempt >= this.maxRetries || !isTransientFailure(last)) {
        return { ...last, attempts: attempt + 1 };
      }
      const delay = retryDelayMs(last, attempt + 1, this.retryBaseMs);
      opts.onRetry?.(
        `rate-limit/transient failure — retry ${attempt + 1}/${this.maxRetries} in ${Math.round(delay / 1000)}s`
      );
      await sleep(delay);
    }
    return { ...last, attempts: this.maxRetries + 1 };
  }
}

const TRANSIENT_RE =
  /\b429\b|\b50[0-9]\b|rate[- ]?limit|too many requests|quota|over\s?loaded|high demand|reconnecting|temporarily unavailable|service unavailable|server error|econnreset|etimedout|enotfound|fetch failed|socket hang\s?up|stream (?:disconnected|error|closed)|connection (?:reset|error)/i;

/** A failure worth retrying: not ok, not a wall-clock timeout, and looks transient. */
export function isTransientFailure(res: AdapterRunResult): boolean {
  if (res.ok || res.timedOut) return false;
  // Exited 0 with no output (headless cursor/gemini hiccup) — retry rather than
  // let the lane silently drop out of the fusion.
  if (res.emptyOutput) return true;
  return TRANSIENT_RE.test(`${res.stderr}\n${res.stdout}`);
}

/** Honor a "retry after N" hint if present; otherwise exponential backoff + jitter. */
export function retryDelayMs(res: AdapterRunResult, attempt: number, baseMs: number): number {
  const text = `${res.stderr}\n${res.stdout}`;
  const hint =
    text.match(/retry[-\s]?after[:\s"]+(\d+(?:\.\d+)?)/i) ||
    text.match(/try again in (\d+(?:\.\d+)?)\s*(?:s|sec|seconds)/i) ||
    text.match(/in (\d+(?:\.\d+)?)\s*seconds/i);
  if (hint) return Math.min(Math.ceil(parseFloat(hint[1]) * 1000) + 500, 120_000);
  const expo = baseMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseMs;
  return Math.min(expo + jitter, 90_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
