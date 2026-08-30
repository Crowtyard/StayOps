/**
 * Python 侧探针调用封装：Electron 不直接查询 PostgreSQL / Alembic，
 * 全部经 scripts/desktop_runtime.py（backend/.venv 已验证 Python）执行，
 * 解析其 stdout 单行 JSON。
 */

import { spawn } from "node:child_process";
import { scrubText } from "./scrub";

export interface ProbeOutcome<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
  exitCode: number | null;
}

export interface ProbeRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface ProbeOptions {
  python: string;
  script: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}

/** 运行一次性 Python 探针（windowsHide，无控制台弹窗；超时即终止自己的子进程）。 */
export function runProbe(opts: ProbeOptions): Promise<ProbeRun> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const child = spawn(opts.python, [opts.script, ...opts.args], {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      // 只终止自己启动的探针进程（无进程树：一次性 CLI）
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${String(err)}`, exitCode: null });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

function parseJsonLine<T>(stdout: string): T | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 执行探针并解析 JSON 结果（失败时错误信息含 scrub 后的 stderr 尾部）。 */
export async function probeJson<T extends object>(
  opts: ProbeOptions,
): Promise<ProbeOutcome<T>> {
  const run = await runProbe(opts);
  const data = parseJsonLine<T>(run.stdout);
  if (!data) {
    const tail = scrubText(run.stderr.trim()).slice(-400);
    return {
      ok: false,
      data: null,
      error: tail ? `探针无有效输出：${tail}` : "探针无有效输出",
      exitCode: run.exitCode,
    };
  }
  return { ok: true, data, error: null, exitCode: run.exitCode };
}

export interface PortsCheckData {
  ok: boolean;
  occupied: Array<{ label: string; port: number; pid: string | null }>;
}

export interface DbCheckData {
  ok: boolean;
  error: string | null;
}

export interface MigrationStatusData {
  state: "OK" | "BEHIND" | "MULTI_HEAD" | "ERROR";
  current: string | null;
  heads: string[];
  detail: string | null;
}

export interface MigrationUpgradeData {
  ok: boolean;
  detail: string;
}

export interface ProbeContext {
  python: string;
  probeScript: string;
  cwd: string;
  backendPort: number;
  frontendPort: number;
}

export function portsCheck(ctx: ProbeContext): Promise<ProbeOutcome<PortsCheckData>> {
  return probeJson<PortsCheckData>({
    python: ctx.python,
    script: ctx.probeScript,
    args: [
      "ports-check",
      "--backend-port",
      String(ctx.backendPort),
      "--frontend-port",
      String(ctx.frontendPort),
    ],
    cwd: ctx.cwd,
  });
}

export function dbCheck(ctx: ProbeContext): Promise<ProbeOutcome<DbCheckData>> {
  return probeJson<DbCheckData>({
    python: ctx.python,
    script: ctx.probeScript,
    args: ["db-check"],
    cwd: ctx.cwd,
  });
}

export function migrationStatus(
  ctx: ProbeContext,
): Promise<ProbeOutcome<MigrationStatusData>> {
  return probeJson<MigrationStatusData>({
    python: ctx.python,
    script: ctx.probeScript,
    args: ["migration-status"],
    cwd: ctx.cwd,
  });
}

export function migrationUpgrade(
  ctx: ProbeContext,
): Promise<ProbeOutcome<MigrationUpgradeData>> {
  return probeJson<MigrationUpgradeData>({
    python: ctx.python,
    script: ctx.probeScript,
    args: ["migration-upgrade"],
    cwd: ctx.cwd,
  });
}
