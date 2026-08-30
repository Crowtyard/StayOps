/**
 * 本地进程监督：只管理本进程自己启动的 Backend / Frontend 进程树。
 *
 * D1 §18/§19/§20/§29：
 * - windowsHide + detached 启动（无任何控制台弹窗）；
 * - Backend 优雅停机 = 关闭 stdin（uvicorn 桥接到 should_exit）；
 * - Frontend 优雅尝试 = taskkill /T（无 /F），超时后才 taskkill /T /F；
 * - 绝不 taskkill 所有 node/python，绝不 kill 未知端口所有者。
 */

import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OwnedChild {
  label: "backend" | "frontend";
  pid: number;
  proc: ChildProcess;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
}

export interface SpawnBackendOptions {
  python: string;
  runner: string;
  cwd: string;
  host: string;
  port: number;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
  onExit?: (label: string, code: number | null) => void;
}

export interface SpawnFrontendOptions {
  nodeExe: string;
  serverJs: string;
  cwd: string;
  host: string;
  port: number;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
  onExit?: (label: string, code: number | null) => void;
}

export interface StopOptions {
  /** 优雅等待时长（ms），超时后强制终止自己拥有的进程树 */
  graceMs?: number;
  /** 强制终止后的最终等待时长（ms） */
  forceMs?: number;
}

const DEFAULT_GRACE_MS = 8_000;
const DEFAULT_FORCE_MS = 4_000;

function makeSpawnEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...extra };
}

export class ProcessSupervisor {
  private readonly children = new Map<string, OwnedChild>();

  spawnBackend(opts: SpawnBackendOptions): OwnedChild {
    const proc = spawn(
      opts.python,
      [opts.runner],
      {
        cwd: opts.cwd,
        windowsHide: true,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: makeSpawnEnv({
          STAYOPS_BACKEND_HOST: opts.host,
          STAYOPS_BACKEND_PORT: String(opts.port),
          ...(opts.env ?? {}),
        }),
      },
    );
    return this.register("backend", proc, opts.onOutput, opts.onExit);
  }

  spawnFrontend(opts: SpawnFrontendOptions): OwnedChild {
    const proc = spawn(
      opts.nodeExe,
      [opts.serverJs],
      {
        cwd: opts.cwd,
        windowsHide: true,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: makeSpawnEnv({
          HOSTNAME: opts.host,
          PORT: String(opts.port),
          NODE_ENV: "production",
          ...(opts.env ?? {}),
        }),
      },
    );
    return this.register("frontend", proc, opts.onOutput, opts.onExit);
  }

  private register(
    label: "backend" | "frontend",
    proc: ChildProcess,
    onOutput?: (text: string) => void,
    onExit?: (label: string, code: number | null) => void,
  ): OwnedChild {
    const child: OwnedChild = {
      label,
      pid: proc.pid ?? 0,
      proc,
      startedAt: Date.now(),
      exited: false,
      exitCode: null,
    };
    this.children.set(label, child);
    proc.stdout?.on("data", (chunk: Buffer) => {
      onOutput?.(chunk.toString("utf8"));
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      onOutput?.(chunk.toString("utf8"));
    });
    proc.once("error", () => {
      child.exited = true;
    });
    proc.once("exit", (code) => {
      child.exited = true;
      child.exitCode = code;
      this.children.delete(label);
      onExit?.(label, code);
    });
    return child;
  }

  /** 记录的所有自持子进程 PID（D1 §18：必须记录自己启动的 PID）。 */
  ownedPids(): Record<string, number> {
    const pids: Record<string, number> = {};
    for (const [label, child] of this.children) {
      pids[label] = child.pid;
    }
    return pids;
  }

  isRunning(label: "backend" | "frontend"): boolean {
    const child = this.children.get(label);
    return child !== undefined && !child.exited;
  }

  hasChildren(): boolean {
    return this.children.size > 0;
  }

  /** 优雅停止单个子进程树（Backend：stdin EOF；Frontend：taskkill /T 尝试）。 */
  async stop(label: "backend" | "frontend", opts: StopOptions = {}): Promise<void> {
    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    const forceMs = opts.forceMs ?? DEFAULT_FORCE_MS;
    const child = this.children.get(label);
    if (!child) return;
    if (child.exited) {
      this.children.delete(label);
      return;
    }
    if (label === "backend") {
      await this.gracefulCloseStdin(child, graceMs);
    } else {
      await this.gracefulTaskkill(child, graceMs);
    }
    if (!child.exited) {
      await this.forceKillTree(child, forceMs);
    }
    if (child.exited) {
      this.children.delete(label);
    }
  }

  /** 停止全部自持进程（先前端后后端；幂等）。 */
  async stopAll(opts: StopOptions = {}): Promise<void> {
    await this.stop("frontend", opts);
    await this.stop("backend", opts);
  }

  private async gracefulCloseStdin(
    child: OwnedChild,
    graceMs: number,
  ): Promise<void> {
    try {
      child.proc.stdin?.end();
    } catch {
      // stdin 已关闭/子进程已退出
    }
    await this.waitExit(child, graceMs);
  }

  private async gracefulTaskkill(child: OwnedChild, graceMs: number): Promise<void> {
    try {
      await execFileAsync("taskkill", ["/PID", String(child.pid), "/T"], {
        windowsHide: true,
      });
    } catch {
      // taskkill 无 /F 对无窗口进程可能失败：视为优雅尝试无果，走超时强杀路径
    }
    await this.waitExit(child, graceMs);
  }

  private async forceKillTree(child: OwnedChild, forceMs: number): Promise<void> {
    try {
      await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } catch {
      // 进程可能已退出（taskkill 报错即目标不存在）
    }
    await this.waitExit(child, forceMs);
  }

  private async waitExit(child: OwnedChild, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !child.exited) {
      await sleep(100);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
