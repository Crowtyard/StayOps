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
  env?: NodeJS.ProcessEnv;
}

/** 运行一次性 Python 探针（windowsHide，无控制台弹窗；超时即终止自己的子进程）。 */
export function runProbe(opts: ProbeOptions): Promise<ProbeRun> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const child = spawn(opts.python, [opts.script, ...opts.args], {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env,
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

export interface DbEnsureData {
  ok: boolean;
  initialized: boolean;
  dbUrl: string | null;
  error: string | null;
}

/** 自带 PostgreSQL Runtime 的路径参数（与 config.ts 的 DesktopPaths 对应）。 */
export interface PgRuntimePaths {
  bin: string;
  data: string;
  creds: string;
  port: number;
}

/**
 * 每台安装独立的 AI_ENCRYPTION_KEY（§8 security）。
 * key 仅经进程管道返回给主进程注入 backend 环境变量，绝不写日志/前端。
 */
export interface AiKeyEnsureData {
  ok: boolean;
  created: boolean;
  key: string | null;
  error: string | null;
}

/** AI 加密密钥的存储位置参数（与 config.ts 的 DesktopPaths 对应）。 */
export interface AiKeyPaths {
  keyFile: string;
  configDir: string;
}

/** 首次安装 bootstrap 管理员凭据（仅 created=true 时返回密码，show-once）。 */
export interface AdminBootstrapData {
  ok: boolean;
  created: boolean;
  password: string | null;
  protection: string | null;
  error: string | null;
}

export interface SeedEnsureData {
  ok: boolean;
  seeded: boolean;
  /** 首次安装生成了 bootstrap 管理员凭据（此时 password 才非空，仅显示一次） */
  createdBootstrap: boolean;
  /** 用户已完成首次改密 → bootstrap 凭据已销毁（不再保留任何引导凭据） */
  bootstrapCleared: boolean;
  password: string | null;
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

/** 确保自带 PostgreSQL Runtime 运行（init / start / ready / 建库），成功返回 dbUrl。 */
export function dbEnsure(
  ctx: ProbeContext,
  pg: PgRuntimePaths,
): Promise<ProbeOutcome<DbEnsureData>> {
  return probeJson<DbEnsureData>({
    python: ctx.python,
    script: ctx.probeScript,
    args: [
      "db-ensure",
      "--pg-bin",
      pg.bin,
      "--data-dir",
      pg.data,
      "--creds-file",
      pg.creds,
      "--port",
      String(pg.port),
      "--timeout-ms",
      "120000",
    ],
    cwd: ctx.cwd,
    timeoutMs: 180_000,
  });
}

/**
 * 确保每台安装独立的 AI_ENCRYPTION_KEY 存在（§8 security）：
 * packaged 模式绝不允许回退到公开 dev 默认值；密钥经进程管道返回，不进日志/前端。
 */
export function aiKeyEnsure(
  ctx: ProbeContext,
  cfg: AiKeyPaths,
): Promise<ProbeOutcome<AiKeyEnsureData>> {
  return probeJson<AiKeyEnsureData>({
    python: ctx.python,
    script: ctx.probeScript,
    args: [
      "ai-key-ensure",
      "--key-file",
      cfg.keyFile,
      "--config-dir",
      cfg.configDir,
    ],
    cwd: ctx.cwd,
    timeoutMs: 60_000,
  });
}

/** 确保首次安装 bootstrap 管理员凭据存在（created=true 时返回密码供 UI 显示一次）。 */
export function adminBootstrapEnsure(
  ctx: ProbeContext,
  cfg: AiKeyPaths,
): Promise<ProbeOutcome<AdminBootstrapData>> {
  return probeJson<AdminBootstrapData>({
    python: ctx.python,
    script: ctx.probeScript,
    args: [
      "admin-bootstrap-ensure",
      "--bootstrap-file",
      cfg.keyFile,
      "--config-dir",
      cfg.configDir,
    ],
    cwd: ctx.cwd,
    timeoutMs: 60_000,
  });
}

/** 幂等执行 seed：权限/角色/admin/房型/房间（干净机器首次安装必需）。 */
export function seedEnsure(
  ctx: ProbeContext,
  cfg: AiKeyPaths,
): Promise<ProbeOutcome<SeedEnsureData>> {
  return probeJson<SeedEnsureData>({
    python: ctx.python,
    script: ctx.probeScript,
    args: ["seed-ensure", "--bootstrap-file", cfg.keyFile],
    cwd: ctx.cwd,
    timeoutMs: 180_000,
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
