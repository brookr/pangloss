import { spawn } from 'child_process';

export interface ProcResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface ProcOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  onLog?: (chunk: string) => void;
}

function spawnCollect(
  command: string,
  args: string[] | undefined,
  useShell: boolean,
  opts: ProcOpts
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args ?? [], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      opts.onLog?.(s);
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      opts.onLog?.(s);
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, stdout: stdout.trim(), stderr: stderr.trim(), code, timedOut });
    };

    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err instanceof Error ? err.message : String(err)}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));

    if (opts.input != null && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

/** Run a program with explicit argv (no shell interpolation). */
export function run(command: string, args: string[], opts: ProcOpts = {}): Promise<ProcResult> {
  return spawnCollect(command, args, false, opts);
}

/** Run a shell command string (used for user-configured manifest commands). */
export function runShell(command: string, opts: ProcOpts = {}): Promise<ProcResult> {
  return spawnCollect(command, undefined, true, opts);
}
