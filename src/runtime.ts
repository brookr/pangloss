import { mkdir, readFile, writeFile } from 'fs/promises';
import { isAbsolute, join } from 'path';
import YAML from 'yaml';
import { ComposeConfig, TargetManifest } from './types.js';
import { ProcResult, run, runShell } from './util/proc.js';

export type RuntimeEnv = Record<string, string>;

export interface AgentRuntime {
  /** Env vars to inject into the agent's coding + validation (e.g. DATABASE_URL). */
  readonly env: RuntimeEnv;
  /** Bring up per-agent services and prepare them. */
  up(): Promise<void>;
  /** Tear everything down (best-effort). */
  down(): Promise<void>;
}

/** No external runtime — build/test run directly (CLIs, simple apps). */
export class NoneRuntime implements AgentRuntime {
  readonly env: RuntimeEnv = {};
  async up(): Promise<void> {
    /* nothing to do */
  }
  async down(): Promise<void> {
    /* nothing to do */
  }
}

export interface ComposeRuntimeOpts {
  repoRoot: string;
  worktreePath: string;
  runId: string;
  agentId: string;
  index: number;
  config: ComposeConfig;
  log: (msg: string) => void;
}

/**
 * Per-agent Docker Compose isolation. Generates a port-rewritten COPY of the
 * target's compose (the source is never touched), brings it up under a unique
 * project name — its own network + volumes — waits for the DB, migrates/seeds,
 * and injects the connection string. Teardown removes the stack and its volumes.
 */
export class ComposeRuntime implements AgentRuntime {
  readonly env: RuntimeEnv = {};
  private readonly project: string;
  private readonly hostPort: number;
  private readonly generatedFile: string;
  private readonly dbService: string;
  private readonly containerPort: number;

  constructor(private readonly opts: ComposeRuntimeOpts) {
    const c = opts.config;
    this.dbService = c.dbService ?? 'db';
    this.containerPort = c.dbContainerPort ?? 5432;
    this.hostPort = (c.dbPortBase ?? 5440) + opts.index;
    this.project = sanitizeProject(`pangloss-${opts.runId}-${opts.agentId}`);
    this.generatedFile = join(opts.worktreePath, '.pangloss', 'compose.generated.yml');

    if (c.urlEnv) {
      const tmpl = c.urlTemplate ?? 'postgres://test_user:test_password@localhost:{port}/test_db';
      this.env[c.urlEnv] = tmpl.replace('{port}', String(this.hostPort));
    }
    this.env.PANGLOSS_DB_PORT = String(this.hostPort);
  }

  async up(): Promise<void> {
    const c = this.opts.config;
    const composePath = isAbsolute(c.file) ? c.file : join(this.opts.repoRoot, c.file);
    const rewritten = rewriteComposePort(await readFile(composePath, 'utf-8'), this.dbService, this.hostPort, this.containerPort);
    await mkdir(join(this.opts.worktreePath, '.pangloss'), { recursive: true });
    await writeFile(this.generatedFile, rewritten);

    this.opts.log(`compose up (project ${this.project}, ${this.dbService} → :${this.hostPort})`);
    const upRes = await this.compose(['up', '-d']);
    if (!upRes.ok) throw new Error(`compose up failed: ${(upRes.stderr || upRes.stdout).slice(-400)}`);

    await this.waitForDb(c.readyTimeoutMs ?? 60_000);

    if (c.dbSetup) {
      this.opts.log('db setup (migrate + seed)…');
      const res = await runShell(c.dbSetup, {
        cwd: this.opts.worktreePath,
        env: { ...process.env, ...this.env },
        timeoutMs: Math.max(c.readyTimeoutMs ?? 0, 600_000)
      });
      if (!res.ok) this.opts.log(`db setup exited nonzero (continuing): ${res.stderr.slice(-300)}`);
    }
  }

  async down(): Promise<void> {
    await this.compose(['down', '-v']).catch(() => undefined);
  }

  private compose(args: string[]): Promise<ProcResult> {
    return run('docker', ['compose', '-p', this.project, '-f', this.generatedFile, ...args], {
      cwd: this.opts.worktreePath,
      timeoutMs: 180_000
    });
  }

  private async waitForDb(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await run(
        'docker',
        ['compose', '-p', this.project, '-f', this.generatedFile, 'exec', '-T', this.dbService, 'pg_isready'],
        { cwd: this.opts.worktreePath, timeoutMs: 15_000 }
      );
      if (res.ok) return;
      if (Date.now() > deadline) throw new Error(`DB not ready after ${Math.round(timeoutMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

/** Docker Compose project names must be lowercase [a-z0-9_-], starting alphanumeric. */
export function sanitizeProject(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '');
  return cleaned.slice(0, 60) || 'pangloss';
}

/**
 * Return a copy of the compose YAML with the named service's published ports
 * replaced by a single `hostPort:containerPort` mapping. Other services are left
 * untouched. (Compose merges `-f` overlays by *appending* ports, which would
 * leave the original mapping in place — so we rewrite a full copy instead.)
 */
export function rewriteComposePort(yamlText: string, service: string, hostPort: number, containerPort: number): string {
  const doc = (YAML.parse(yamlText) ?? {}) as { services?: Record<string, { ports?: unknown[] }> };
  const svc = doc.services?.[service];
  if (svc) {
    svc.ports = [`${hostPort}:${containerPort}`];
  }
  return YAML.stringify(doc);
}

/** Choose the runtime for an agent based on the manifest. */
export function createRuntime(args: {
  manifest: TargetManifest;
  repoRoot: string;
  worktreePath: string;
  runId: string;
  agentId: string;
  index: number;
  log: (msg: string) => void;
}): AgentRuntime {
  const { manifest, ...rest } = args;
  if (!manifest.compose) return new NoneRuntime();
  return new ComposeRuntime({ ...rest, config: manifest.compose });
}
