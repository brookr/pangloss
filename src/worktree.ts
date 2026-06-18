import { mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { run } from './util/proc.js';

export interface Worktree {
  agentId: string;
  branch: string;
  path: string;
}

export interface AgentStatus {
  done: boolean;
  summary?: string;
  remaining_work?: string[];
  tests?: { build_passed?: boolean; tests_passed?: number; tests_failed?: number };
  notes_for_reviewers?: string[];
}

/**
 * Owns all git-worktree lifecycle and boundary enforcement. One instance per
 * run. Worktrees live under `.pangloss/runs/<runId>/worktrees/<agentId>` (an
 * ignored path), each on branch `pangloss/<runId>/<agentId>`.
 */
export class WorktreeManager {
  constructor(
    private readonly repoRoot: string,
    private readonly runId: string
  ) {}

  branchFor(agentId: string, round = 0): string {
    return `pangloss/${this.runId}/r${round}/${agentId}`;
  }

  private baseDirFor(round: number): string {
    return join(this.repoRoot, '.pangloss', 'runs', this.runId, `round-${round}`, 'worktrees');
  }

  private async git(args: string[], cwd: string = this.repoRoot) {
    return run('git', args, { cwd, timeoutMs: 60_000 });
  }

  /** Create an isolated worktree on a fresh branch off `baseRef`. */
  async create(agentId: string, baseRef: string, round = 0): Promise<Worktree> {
    const baseDir = this.baseDirFor(round);
    await mkdir(baseDir, { recursive: true });
    const branch = this.branchFor(agentId, round);
    const path = join(baseDir, agentId);

    // Remove any stale worktree/branch from a previous aborted run with this id.
    await this.git(['worktree', 'remove', '--force', path]).catch(() => undefined);
    await this.git(['branch', '-D', branch]).catch(() => undefined);

    const res = await this.git(['worktree', 'add', '-b', branch, path, baseRef]);
    if (!res.ok) {
      throw new Error(`Failed to create worktree for ${agentId}: ${res.stderr || res.stdout}`);
    }

    await mkdir(join(path, '.pangloss'), { recursive: true });
    return { agentId, branch, path };
  }

  /** Remove the worktree directory. Branch is kept by default for inspection/PR. */
  async remove(wt: Worktree, deleteBranch = false): Promise<void> {
    await this.git(['worktree', 'remove', '--force', wt.path]).catch(() => undefined);
    await this.git(['worktree', 'prune']).catch(() => undefined);
    if (deleteBranch) {
      await this.git(['branch', '-D', wt.branch]).catch(() => undefined);
    }
  }

  async headSha(wt: Worktree): Promise<string> {
    const res = await this.git(['rev-parse', 'HEAD'], wt.path);
    return res.ok ? res.stdout.trim() : '';
  }

  async isDirty(wt: Worktree): Promise<boolean> {
    const res = await this.git(['status', '--porcelain'], wt.path);
    return res.ok && res.stdout.trim().length > 0;
  }

  /** True if `refA` and `refB` point at identical trees (no diff between them). */
  async treesIdentical(refA: string, refB: string): Promise<boolean> {
    const res = await this.git(['diff', '--quiet', refA, refB]);
    return res.ok; // `git diff --quiet` exits 0 only when there are no differences
  }

  /** Stage everything and commit; returns true if a commit was made. */
  async commitAll(wt: Worktree, message: string): Promise<boolean> {
    await this.git(['add', '-A'], wt.path);
    const staged = await this.git(['diff', '--cached', '--quiet'], wt.path);
    // `--quiet` exits 1 when there ARE staged changes.
    if (staged.ok) return false;
    const res = await this.git(['commit', '-m', message, '--no-verify'], wt.path);
    return res.ok;
  }

  async changedFiles(wt: Worktree, baseRef: string): Promise<string[]> {
    const res = await this.git(['diff', '--name-only', `${baseRef}...HEAD`], wt.path);
    if (!res.ok) return [];
    return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  async diffStat(wt: Worktree, baseRef: string): Promise<string> {
    const res = await this.git(['diff', '--shortstat', `${baseRef}...HEAD`], wt.path);
    return res.ok ? res.stdout.trim() : '';
  }

  /** Full unified diff vs base — fed to reviewers. Truncated by the caller if huge. */
  async fullDiff(wt: Worktree, baseRef: string): Promise<string> {
    const res = await this.git(['diff', `${baseRef}...HEAD`], wt.path);
    return res.ok ? res.stdout : '';
  }

  /**
   * Enforce that a read-only phase (review) left the worktree untouched. If the
   * agent mutated tracked files or committed, revert to `startingSha` and report
   * the violation. node_modules / .pangloss are preserved.
   */
  async enforceReadOnly(wt: Worktree, startingSha: string): Promise<boolean> {
    const currentSha = await this.headSha(wt);
    const dirty = await this.isDirty(wt);
    const headMoved = startingSha && currentSha && startingSha !== currentSha;
    if (!dirty && !headMoved) return false;

    await this.git(['reset', '--hard', startingSha], wt.path).catch(() => undefined);
    await this.git(['clean', '-fd', '-e', 'node_modules', '-e', '.pangloss'], wt.path).catch(() => undefined);
    return true;
  }

  /** Read the agent's self-reported status file, if present. */
  async readStatus(wt: Worktree): Promise<AgentStatus | null> {
    const p = join(wt.path, '.pangloss', 'agent-status.json');
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(await readFile(p, 'utf-8')) as AgentStatus;
    } catch {
      return null;
    }
  }
}
