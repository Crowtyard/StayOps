/**
 * 启动状态机（Desktop D1 §15/§16/§28）：
 *
 *   环境检查 → 端口检查 → 数据库连接 → 迁移检查 → 启动后端 → 启动前端 → Ready
 *
 * - 迁移落后：不发「自动 upgrade」，只推送 migration-behind 事件，
 *   由用户点击确认后调用 upgrade()（D1 §13）。
 * - 多 head / 迁移错误：Fail Safe（错误 UI）。
 * - 任何失败：推送 error 事件（人类可读 message + 可选 detail）。
 * - retry()：先清理自己启动的进程，再从头运行。
 */

import fs from "node:fs";
import path from "node:path";
import type { DesktopPaths } from "./config";
import {
  DESKTOP_BACKEND_HOST,
  DESKTOP_BACKEND_PORT,
  DESKTOP_FRONTEND_HOST,
  DESKTOP_FRONTEND_PORT,
} from "./config";
import type { OccupiedPort } from "./preflight";
import type {
  DbCheckData,
  DbEnsureData,
  MigrationStatusData,
  MigrationUpgradeData,
  ProbeOutcome,
} from "./probe";
import type { OwnedChild, ProcessSupervisor } from "./processes";

export type PhaseId =
  | "env"
  | "ports"
  | "database"
  | "migration"
  | "backend"
  | "frontend";

export type ErrorCode =
  | "ENV_MISSING"
  | "PORT_OCCUPIED"
  | "DB_UNAVAILABLE"
  | "MIGRATION_ERROR"
  | "BACKEND_FAILED"
  | "FRONTEND_FAILED"
  | "UNKNOWN";

export type StartupEvent =
  | {
      type: "phase";
      phase: PhaseId;
      status: "loading" | "ok" | "error";
      detail?: string;
    }
  | { type: "migration-behind"; current: string; head: string }
  | { type: "error"; code: ErrorCode; message: string; detail?: string }
  | { type: "ready"; backendUrl: string; frontendUrl: string };

export interface StartupDeps {
  paths: DesktopPaths;
  supervisor: ProcessSupervisor;
  findOccupants: () => Promise<OccupiedPort[]>;
  /** 确保自带 PostgreSQL Runtime 运行（init/start/ready/建库）；成功后主进程注入 DATABASE_URL。 */
  dbEnsure: () => Promise<ProbeOutcome<DbEnsureData>>;
  dbCheck: () => Promise<ProbeOutcome<DbCheckData>>;
  migrationStatus: () => Promise<ProbeOutcome<MigrationStatusData>>;
  migrationUpgrade: () => Promise<ProbeOutcome<MigrationUpgradeData>>;
  spawnBackend: () => OwnedChild;
  spawnFrontend: () => OwnedChild;
  /** 解析 node 可执行文件（不存在返回 null） */
  resolveNode: () => Promise<string | null>;
  waitHttp: (url: string, timeoutMs: number, label: string) => Promise<boolean>;
  checkCoreRoutes: (backendUrl: string) => Promise<boolean>;
  tailLog: (label: string, lines?: number) => string;
  onEvent: (event: StartupEvent) => void;
}

const PHASES: readonly PhaseId[] = [
  "env",
  "ports",
  "database",
  "migration",
  "backend",
  "frontend",
];

const BACKEND_READY_TIMEOUT_MS = 90_000;
const FRONTEND_READY_TIMEOUT_MS = 180_000;

export class StartupRunner {
  private phaseIndex = 0;
  private running = false;
  private stopped = false;
  private upgrading = false;

  constructor(private readonly deps: StartupDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** 从头运行启动序列（retry 先调用 stop 再 run）。 */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.phaseIndex = 0;
    try {
      await this.runPhases();
    } finally {
      this.running = false;
    }
  }

  /** 用户点击「升级数据库并继续」后调用。 */
  async upgrade(): Promise<void> {
    if (this.upgrading || this.running) return;
    this.upgrading = true;
    try {
      this.deps.onEvent({
        type: "phase",
        phase: "migration",
        status: "loading",
        detail: "正在升级数据库…",
      });
      const result = await this.deps.migrationUpgrade();
      if (!result.ok || !result.data?.ok) {
        this.deps.onEvent({
          type: "error",
          code: "MIGRATION_ERROR",
          message: "数据库升级失败",
          detail: result.data?.detail ?? result.error ?? undefined,
        });
        return;
      }
      const status = await this.deps.migrationStatus();
      const state = status.data?.state;
      if (state === "OK") {
        this.deps.onEvent({
          type: "phase",
          phase: "migration",
          status: "ok",
          detail: `数据库已升级至 ${status.data?.heads?.[0] ?? ""}`,
        });
        this.phaseIndex += 1;
        this.running = true;
        try {
          await this.runPhases();
        } finally {
          this.running = false;
        }
      } else if (state === "BEHIND") {
        this.deps.onEvent({
          type: "error",
          code: "MIGRATION_ERROR",
          message: "升级后数据库仍然落后",
          detail: `当前 ${status.data?.current ?? "?"} → 目标 ${status.data?.heads?.[0] ?? "?"}`,
        });
      } else {
        this.deps.onEvent({
          type: "error",
          code: "MIGRATION_ERROR",
          message: "升级后迁移状态异常（Fail Safe）",
          detail: status.data?.detail ?? undefined,
        });
      }
    } finally {
      this.upgrading = false;
    }
  }

  /** 停止自己启动的进程（退出 / 重试前调用）。 */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.deps.supervisor.stopAll();
  }

  /** 重新检查：清理自持进程后从头运行。 */
  async retry(): Promise<void> {
    this.stopped = false;
    await this.deps.supervisor.stopAll();
    await this.run();
  }

  // ------------------------------------------------------------------

  private async runPhases(): Promise<void> {
    for (; this.phaseIndex < PHASES.length; this.phaseIndex++) {
      if (this.stopped) return;
      const phase = PHASES[this.phaseIndex]!;
      const ok = await this.executePhase(phase);
      if (!ok) return;
    }
    this.deps.onEvent({
      type: "ready",
      backendUrl: this.backendUrl(),
      frontendUrl: this.frontendUrl(),
    });
  }

  private backendUrl(): string {
    return `http://${DESKTOP_BACKEND_HOST}:${DESKTOP_BACKEND_PORT}`;
  }

  private frontendUrl(): string {
    return `http://${DESKTOP_FRONTEND_HOST}:${DESKTOP_FRONTEND_PORT}`;
  }

  private emitPhase(phase: PhaseId, status: "loading" | "ok" | "error", detail?: string) {
    this.deps.onEvent({ type: "phase", phase, status, detail });
  }

  private emitError(code: ErrorCode, message: string, detail?: string): void {
    this.deps.onEvent({ type: "error", code, message, detail });
  }

  private async executePhase(phase: PhaseId): Promise<boolean> {
    this.emitPhase(phase, "loading");
    switch (phase) {
      case "env":
        return this.phaseEnv();
      case "ports":
        return this.phasePorts();
      case "database":
        return this.phaseDatabase();
      case "migration":
        return this.phaseMigration();
      case "backend":
        return this.phaseBackend();
      case "frontend":
        return this.phaseFrontend();
    }
  }

  private async phaseEnv(): Promise<boolean> {
    const p = this.deps.paths;
    const missing: string[] = [];
    if (!fs.existsSync(p.venvPython)) missing.push("backend/.venv/Scripts/python.exe");
    if (!fs.existsSync(p.frontendServerJs)) missing.push("frontend standalone server.js");
    const pgBinMissing = ["postgres.exe", "initdb.exe", "pg_ctl.exe", "psql.exe"].filter(
      (name) => !fs.existsSync(path.join(p.pgBinDir, name)),
    );
    if (pgBinMissing.length > 0) {
      missing.push(`runtime/postgres/pgsql/bin（缺少 ${pgBinMissing.join("、")}）`);
    }
    if (missing.length > 0) {
      this.emitPhase("env", "error");
      this.emitError(
        "ENV_MISSING",
        "缺少运行所需文件",
        `未找到：${missing.join("、")}\n请确认 StayOps 工作区完整（backend/.venv 与前端生产构建）。`,
      );
      return false;
    }
    const nodePath = await this.deps.resolveNode();
    if (!nodePath) {
      this.emitPhase("env", "error");
      this.emitError(
        "ENV_MISSING",
        "未找到 Node.js 运行时",
        `请确认 node 在 PATH 中，或设置环境变量 STAYOPS_NODE 指向 node.exe。`,
      );
      return false;
    }
    this.emitPhase("env", "ok");
    return true;
  }

  private async phasePorts(): Promise<boolean> {
    const occupied = await this.deps.findOccupants();
    if (occupied.length > 0) {
      const first = occupied[0]!;
      this.emitPhase("ports", "error");
      this.emitError(
        "PORT_OCCUPIED",
        `端口 ${first.port} 已被占用${first.pid ? `（PID ${first.pid}）` : ""}`,
        occupied
          .map(
            (o) =>
              `${o.label === "backend" ? "后端" : "前端"}端口 ${o.port} 被 PID ${o.pid ?? "未知"} 占用`,
          )
          .join("\n") +
          "\n请关闭占用程序后点击「重新检查」。StayOps 不会终止未知进程。",
      );
      return false;
    }
    this.emitPhase("ports", "ok");
    return true;
  }

  private async phaseDatabase(): Promise<boolean> {
    // 自带 PostgreSQL Runtime：检测 → 启动/初始化 → 等待就绪 → 建库（docs/DECISIONS.md）
    const result = await this.deps.dbEnsure();
    if (!result.ok || !result.data?.ok) {
      this.emitPhase("database", "error");
      this.emitError(
        "DB_UNAVAILABLE",
        "无法启动本地数据库（PostgreSQL）",
        result.data?.error ?? result.error ?? undefined,
      );
      return false;
    }
    this.emitPhase(
      "database",
      "ok",
      result.data.initialized ? "本地数据库已初始化（127.0.0.1:5433）" : "本地数据库已就绪（127.0.0.1:5433）",
    );
    return true;
  }

  private async phaseMigration(): Promise<boolean> {
    const result = await this.deps.migrationStatus();
    const data = result.data;
    if (!result.ok || !data) {
      this.emitPhase("migration", "error");
      this.emitError(
        "MIGRATION_ERROR",
        "无法读取数据库迁移状态",
        data?.detail ?? result.error ?? undefined,
      );
      return false;
    }
    if (data.state === "OK") {
      this.emitPhase("migration", "ok", `current == head == ${data.heads[0] ?? ""}`);
      return true;
    }
    if (data.state === "MULTI_HEAD") {
      this.emitPhase("migration", "error");
      this.emitError(
        "MIGRATION_ERROR",
        "数据库存在多个迁移头（Fail Safe）",
        `heads: ${data.heads.join(", ")}\n请人工处理 Alembic 多 head 后再启动。`,
      );
      return false;
    }
    if (data.state === "BEHIND") {
      this.emitPhase("migration", "error");
      this.deps.onEvent({
        type: "migration-behind",
        current: data.current ?? "?",
        head: data.heads[0] ?? "?",
      });
      return false;
    }
    this.emitPhase("migration", "error");
    this.emitError("MIGRATION_ERROR", "迁移状态异常", data.detail ?? undefined);
    return false;
  }

  private async phaseBackend(): Promise<boolean> {
    this.deps.spawnBackend();
    const ready = await this.deps.waitHttp(
      `${this.backendUrl()}/health`,
      BACKEND_READY_TIMEOUT_MS,
      "Backend /health",
    );
    if (!ready) {
      this.emitPhase("backend", "error");
      this.emitError(
        "BACKEND_FAILED",
        "后端未能就绪",
        `查看日志目录中的 backend.log。\n${this.deps.tailLog("backend")}`,
      );
      return false;
    }
    const routesOk = await this.deps.checkCoreRoutes(this.backendUrl());
    if (!routesOk) {
      this.emitPhase("backend", "error");
      this.emitError(
        "BACKEND_FAILED",
        "后端核心业务路由缺失",
        "当前后端版本疑似过旧（缺少 Rooms/Reservations/Housekeeping/Maintenance 路由）。",
      );
      return false;
    }
    this.emitPhase("backend", "ok");
    return true;
  }

  private async phaseFrontend(): Promise<boolean> {
    this.deps.spawnFrontend();
    const ready = await this.deps.waitHttp(
      `${this.frontendUrl()}/login`,
      FRONTEND_READY_TIMEOUT_MS,
      "Frontend /login",
    );
    if (!ready) {
      this.emitPhase("frontend", "error");
      this.emitError(
        "FRONTEND_FAILED",
        "前端未能就绪",
        `查看日志目录中的 frontend.log。\n${this.deps.tailLog("frontend")}`,
      );
      return false;
    }
    this.emitPhase("frontend", "ok");
    return true;
  }
}
