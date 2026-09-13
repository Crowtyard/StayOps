import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StartupRunner, type StartupDeps, type StartupEvent } from "../startup";
import type { DesktopPaths } from "../config";
import type { OccupiedPort } from "../preflight";

const FAKE_PATHS: DesktopPaths = {
  workspaceRoot: "C:\\stayops",
  mode: "development",
  backendDir: "C:\\stayops\\backend",
  venvPython: "C:\\stayops\\backend\\.venv\\Scripts\\python.exe",
  scriptsDir: "C:\\stayops\\scripts",
  backendRunner: "C:\\stayops\\backend\\scripts\\desktop_backend_runner.py",
  desktopProbe: "C:\\stayops\\scripts\\desktop_runtime.py",
  frontendStandaloneDir: "C:\\stayops\\frontend\\.next-desktop\\standalone",
  frontendServerJs: "C:\\stayops\\frontend\\.next-desktop\\standalone\\server.js",
  nodeExe: "node",
  logsDir: "C:\\Users\\t\\AppData\\Local\\StayOps\\logs",
  trayIcon: "C:\\stayops\\desktop\\assets\\tray.png",
  appIcon: "C:\\stayops\\desktop\\assets\\app-icon.png",
  pgBinDir: "C:\\stayops\\runtime\\postgres\\pgsql\\bin",
  pgDataDir: "C:\\ProgramData\\StayOps\\PostgreSQL\\data",
  pgCredsFile: "C:\\ProgramData\\StayOps\\PostgreSQL\\conf\\dbpass.conf",
  configDir: "C:\\ProgramData\\StayOps\\config",
  aiKeyFile: "C:\\ProgramData\\StayOps\\config\\ai_encryption.key",
  adminBootstrapFile: "C:\\ProgramData\\StayOps\\config\\admin-bootstrap.dat",
  startupHtml: "C:\\stayops\\desktop\\src\\startup\\index.html",
};

const tmpRoots: string[] = [];

/** 真实存在的临时路径（env 阶段用 fs.existsSync 校验）。 */
function realPaths(): DesktopPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stayops-startup-"));
  tmpRoots.push(root);
  const venv = path.join(root, "backend", ".venv", "Scripts", "python.exe");
  const serverJs = path.join(root, "frontend", ".next-desktop", "standalone", "server.js");
  const pgBin = path.join(root, "runtime", "postgres", "pgsql", "bin");
  fs.mkdirSync(path.dirname(venv), { recursive: true });
  fs.mkdirSync(path.dirname(serverJs), { recursive: true });
  fs.mkdirSync(pgBin, { recursive: true });
  fs.writeFileSync(venv, "");
  fs.writeFileSync(serverJs, "");
  for (const exe of ["postgres.exe", "initdb.exe", "pg_ctl.exe", "psql.exe"]) {
    fs.writeFileSync(path.join(pgBin, exe), "");
  }
  return { ...FAKE_PATHS, venvPython: venv, frontendServerJs: serverJs, pgBinDir: pgBin };
}

afterAll(() => {
  for (const root of tmpRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** packed runtime layout（resources/{backend,python,postgres,frontend-server}）临时目录。 */
function packagedPaths(overrides: Partial<DesktopPaths> = {}): DesktopPaths {
  const res = fs.mkdtempSync(path.join(os.tmpdir(), "stayops-packaged-"));
  tmpRoots.push(res);
  const py = path.join(res, "python", "python.exe");
  const serverJs = path.join(res, "frontend-server", "server.js");
  const pgBin = path.join(res, "postgres", "pgsql", "bin");
  fs.mkdirSync(path.join(res, "backend", "app"), { recursive: true });
  fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.mkdirSync(path.dirname(serverJs), { recursive: true });
  fs.mkdirSync(pgBin, { recursive: true });
  fs.writeFileSync(path.join(res, "backend", "app", "main.py"), "");
  fs.writeFileSync(py, "");
  fs.writeFileSync(serverJs, "");
  for (const exe of ["postgres.exe", "initdb.exe", "pg_ctl.exe", "psql.exe"]) {
    fs.writeFileSync(path.join(pgBin, exe), "");
  }
  return {
    ...FAKE_PATHS,
    mode: "packaged",
    workspaceRoot: res,
    backendDir: path.join(res, "backend"),
    venvPython: py,
    backendRunner: path.join(res, "backend", "scripts", "desktop_backend_runner.py"),
    desktopProbe: path.join(res, "scripts", "desktop_runtime.py"),
    frontendStandaloneDir: path.join(res, "frontend-server"),
    frontendServerJs: serverJs,
    nodeExe: path.join(res, "node", "node.exe"),
    pgBinDir: pgBin,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<StartupDeps> = {}): {
  deps: StartupDeps;
  events: StartupEvent[];
} {
  const events: StartupEvent[] = [];
  const deps: StartupDeps = {
    paths: realPaths(),
    supervisor: { stopAll: vi.fn().mockResolvedValue(undefined) } as never,
    findOccupants: vi.fn().mockResolvedValue([] as OccupiedPort[]),
    dbEnsure: vi.fn().mockResolvedValue({
      ok: true,
      data: { ok: true, initialized: false, dbUrl: "postgresql://stayops:***@127.0.0.1:5433/stayops", error: null },
      error: null,
      exitCode: 0,
    }),
    dbCheck: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { ok: true, error: null }, error: null, exitCode: 0 }),
    aiKeyEnsure: vi.fn().mockResolvedValue({
      ok: true,
      data: { ok: true, created: false, key: "test-key", error: null },
      error: null,
      exitCode: 0,
    }),
    seedEnsure: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        seeded: true,
        createdBootstrap: false,
        bootstrapCleared: false,
        password: null,
        error: null,
      },
      error: null,
      exitCode: 0,
    }),
    migrationStatus: vi.fn().mockResolvedValue({
      ok: true,
      data: { state: "OK", current: "f5d3b9e7a2c4", heads: ["f5d3b9e7a2c4"], detail: null },
      error: null,
      exitCode: 0,
    }),
    migrationUpgrade: vi.fn().mockResolvedValue({
      ok: true,
      data: { ok: true, detail: "upgraded" },
      error: null,
      exitCode: 0,
    }),
    spawnBackend: vi.fn(),
    spawnFrontend: vi.fn(),
    resolveNode: vi.fn().mockResolvedValue("C:\\node\\node.exe"),
    waitHttp: vi.fn().mockResolvedValue(true),
    checkCoreRoutes: vi.fn().mockResolvedValue(true),
    tailLog: vi.fn().mockReturnValue(""),
    onEvent: (e) => events.push(e),
    ...overrides,
  };
  return { deps, events };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startup: 状态机（D1 §15/§16）", () => {
  it("全链路成功 → ready 事件携带 8100/3100 地址", async () => {
    const { deps, events } = makeDeps();
    const runner = new StartupRunner(deps);
    await runner.run();
    const ready = events.find((e) => e.type === "ready") as
      | { type: "ready"; backendUrl: string; frontendUrl: string }
      | undefined;
    expect(ready).toBeDefined();
    expect(ready!.backendUrl).toBe("http://127.0.0.1:8100");
    expect(ready!.frontendUrl).toBe("http://127.0.0.1:3100");
    expect(deps.spawnBackend).toHaveBeenCalledTimes(1);
    expect(deps.spawnFrontend).toHaveBeenCalledTimes(1);
    // 六个阶段都有 loading → ok
    const phaseEvents = events.filter((e) => e.type === "phase") as Array<{
      phase: string;
      status: string;
    }>;
    expect(phaseEvents.filter((e) => e.status === "loading")).toHaveLength(6);
    expect(phaseEvents.filter((e) => e.status === "ok")).toHaveLength(6);
  });

  it("端口被占用 → PORT_OCCUPIED 错误（含 PID），不启动任何服务", async () => {
    const { deps, events } = makeDeps({
      findOccupants: vi.fn().mockResolvedValue([
        { label: "backend", port: 8100, pid: "12345" },
      ] as OccupiedPort[]),
    });
    const runner = new StartupRunner(deps);
    await runner.run();
    const err = events.find((e) => e.type === "error") as
      | { type: "error"; code: string; message: string }
      | undefined;
    expect(err?.code).toBe("PORT_OCCUPIED");
    expect(err?.message).toContain("12345");
    expect(deps.spawnBackend).not.toHaveBeenCalled();
    expect(deps.spawnFrontend).not.toHaveBeenCalled();
  });

  it("数据库不可达 → DB_UNAVAILABLE（db-ensure 失败，含可读原因）", async () => {
    const { deps, events } = makeDeps({
      dbEnsure: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          ok: false,
          initialized: false,
          dbUrl: null,
          error: "PostgreSQL 启动失败（仅监听 127.0.0.1:5433）：端口被占用",
        },
        error: null,
        exitCode: 0,
      }),
    });
    const runner = new StartupRunner(deps);
    await runner.run();
    const err = events.find((e) => e.type === "error") as
      | { type: string; code: string; message: string; detail?: string }
      | undefined;
    expect(err?.code).toBe("DB_UNAVAILABLE");
    expect(err?.message).toContain("PostgreSQL");
    expect(err?.detail).toContain("127.0.0.1:5433");
    expect(deps.spawnBackend).not.toHaveBeenCalled();
  });

  it("packaged 模式：AI 密钥不可用 → ENV_MISSING（Fail Safe，不启动服务）", async () => {
    const { deps, events } = makeDeps({
      paths: packagedPaths(),
      aiKeyEnsure: vi.fn().mockResolvedValue({
        ok: true,
        data: { ok: false, created: false, key: null, error: "DPAPI 解密失败" },
        error: null,
        exitCode: 0,
      }),
    });
    const runner = new StartupRunner(deps);
    await runner.run();
    const err = events.find((e) => e.type === "error") as
      | { type: string; code: string; message: string; detail?: string }
      | undefined;
    expect(err?.code).toBe("ENV_MISSING");
    expect(err?.detail).toContain("DPAPI");
    expect(deps.spawnBackend).not.toHaveBeenCalled();
    expect(deps.spawnFrontend).not.toHaveBeenCalled();
  });

  it("development 模式：AI 密钥不可用 → 不阻断启动（保留 dev fallback）", async () => {
    const { deps, events } = makeDeps({
      aiKeyEnsure: vi.fn().mockResolvedValue({
        ok: true,
        data: { ok: false, created: false, key: null, error: "no dpapi" },
        error: null,
        exitCode: 0,
      }),
    });
    const runner = new StartupRunner(deps);
    await runner.run();
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(deps.spawnBackend).toHaveBeenCalledTimes(1);
  });

  it("packaged 模式：缺少 bundled Python → ENV_MISSING 指向 resources", async () => {
    const paths = packagedPaths({ venvPython: "C:\\nope\\python\\python.exe" });
    const { deps, events } = makeDeps({ paths });
    const runner = new StartupRunner(deps);
    await runner.run();
    const err = events.find((e) => e.type === "error") as
      | { type: string; code: string; message: string; detail?: string }
      | undefined;
    expect(err?.code).toBe("ENV_MISSING");
    expect(err?.detail).toContain("resources/python/python.exe");
    expect(err?.detail).toContain("重新安装 StayOps");
    expect(deps.aiKeyEnsure).not.toHaveBeenCalled();
  });

  it("多 head → MIGRATION_ERROR（Fail Safe，绝不 upgrade）", async () => {
    const { deps, events } = makeDeps({
      migrationStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          state: "MULTI_HEAD",
          current: "abc123456789",
          heads: ["abc123456789", "def123456789"],
          detail: "multi head",
        },
        error: null,
        exitCode: 0,
      }),
    });
    const runner = new StartupRunner(deps);
    await runner.run();
    const err = events.find((e) => e.type === "error") as { type: string; code: string } | undefined;
    expect(err?.code).toBe("MIGRATION_ERROR");
    expect(deps.migrationUpgrade).not.toHaveBeenCalled();
  });

  it("迁移落后 → migration-behind 事件；upgrade() 确认后继续到 ready", async () => {
    const statusFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          state: "BEHIND",
          current: "e3a91f5c8d24",
          heads: ["f5d3b9e7a2c4"],
          detail: null,
        },
        error: null,
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { state: "OK", current: "f5d3b9e7a2c4", heads: ["f5d3b9e7a2c4"], detail: null },
        error: null,
        exitCode: 0,
      });
    const { deps, events } = makeDeps({ migrationStatus: statusFn });
    const runner = new StartupRunner(deps);
    await runner.run();
    const behind = events.find((e) => e.type === "migration-behind") as
      | { type: string; current: string; head: string }
      | undefined;
    expect(behind).toBeDefined();
    expect(behind!.current).toBe("e3a91f5c8d24");
    expect(behind!.head).toBe("f5d3b9e7a2c4");
    // 未确认前不启动后端
    expect(deps.spawnBackend).not.toHaveBeenCalled();
    expect(deps.migrationUpgrade).not.toHaveBeenCalled();

    await runner.upgrade();
    expect(deps.migrationUpgrade).toHaveBeenCalledTimes(1);
    expect(deps.spawnBackend).toHaveBeenCalledTimes(1);
    const ready = events.find((e) => e.type === "ready");
    expect(ready).toBeDefined();
  });

  it("升级失败 → MIGRATION_ERROR，不继续启动", async () => {
    const { deps, events } = makeDeps({
      migrationStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          state: "BEHIND",
          current: "old",
          heads: ["f5d3b9e7a2c4"],
          detail: null,
        },
        error: null,
        exitCode: 0,
      }),
      migrationUpgrade: vi.fn().mockResolvedValue({
        ok: true,
        data: { ok: false, detail: "alembic upgrade failed" },
        error: null,
        exitCode: 1,
      }),
    });
    const runner = new StartupRunner(deps);
    await runner.run();
    await runner.upgrade();
    const err = events.filter((e) => e.type === "error").at(-1) as
      | { type: string; code: string }
      | undefined;
    expect(err?.code).toBe("MIGRATION_ERROR");
    expect(deps.spawnBackend).not.toHaveBeenCalled();
  });

  it("后端未就绪 → BACKEND_FAILED，detail 含日志尾部", async () => {
    const { deps, events } = makeDeps({
      waitHttp: vi.fn().mockResolvedValue(false),
      tailLog: vi.fn().mockReturnValue("[10:00:00] [backend] ERROR boom"),
    });
    const runner = new StartupRunner(deps);
    await runner.run();
    const err = events.find((e) => e.type === "error") as
      | { type: string; code: string; detail?: string }
      | undefined;
    expect(err?.code).toBe("BACKEND_FAILED");
    expect(err?.detail).toContain("ERROR boom");
    expect(deps.spawnFrontend).not.toHaveBeenCalled();
  });

  it("核心路由缺失 → BACKEND_FAILED", async () => {
    const { deps, events } = makeDeps({ checkCoreRoutes: vi.fn().mockResolvedValue(false) });
    const runner = new StartupRunner(deps);
    await runner.run();
    const err = events.find((e) => e.type === "error") as { type: string; code: string } | undefined;
    expect(err?.code).toBe("BACKEND_FAILED");
    expect(deps.spawnFrontend).not.toHaveBeenCalled();
  });

  it("前端未就绪 → FRONTEND_FAILED", async () => {
    const waitHttp = vi
      .fn()
      .mockResolvedValueOnce(true) // backend /health
      .mockResolvedValueOnce(false); // frontend /login
    const { deps, events } = makeDeps({ waitHttp });
    const runner = new StartupRunner(deps);
    await runner.run();
    const err = events.find((e) => e.type === "error") as { type: string; code: string } | undefined;
    expect(err?.code).toBe("FRONTEND_FAILED");
  });

  it("retry：先清理自持进程再从头运行", async () => {
    const { deps, events } = makeDeps();
    const runner = new StartupRunner(deps);
    await runner.run();
    expect(deps.spawnBackend).toHaveBeenCalledTimes(1);
    await runner.retry();
    expect(deps.supervisor.stopAll).toHaveBeenCalled();
    expect(deps.spawnBackend).toHaveBeenCalledTimes(2);
    const readyCount = events.filter((e) => e.type === "ready").length;
    expect(readyCount).toBe(2);
  });

  it("运行中重复 run() 被忽略（防并发双启动）", async () => {
    const { deps } = makeDeps();
    const runner = new StartupRunner(deps);
    const p1 = runner.run();
    const p2 = runner.run();
    await Promise.all([p1, p2]);
    expect(deps.spawnBackend).toHaveBeenCalledTimes(1);
  });

  it("venv 缺失 → ENV_MISSING，不启动任何进程", async () => {
    const paths = realPaths();
    paths.venvPython = path.join(paths.venvPython, "..", "missing-python.exe");
    const { deps, events } = makeDeps({ paths });
    const runner = new StartupRunner(deps);
    await runner.run();
    const err = events.find((e) => e.type === "error") as { type: string; code: string } | undefined;
    expect(err?.code).toBe("ENV_MISSING");
    expect(deps.spawnBackend).not.toHaveBeenCalled();
    expect(deps.spawnFrontend).not.toHaveBeenCalled();
  });

  it("standalone server.js 缺失 → ENV_MISSING", async () => {
    const paths = realPaths();
    paths.frontendServerJs = path.join(paths.frontendServerJs, "..", "missing-server.js");
    const { deps, events } = makeDeps({ paths });
    const runner = new StartupRunner(deps);
    await runner.run();
    const err = events.find((e) => e.type === "error") as { type: string; code: string } | undefined;
    expect(err?.code).toBe("ENV_MISSING");
  });

  it("node 不可解析 → ENV_MISSING", async () => {
    const { deps, events } = makeDeps({
      resolveNode: vi.fn().mockResolvedValue(null),
    });
    const runner = new StartupRunner(deps);
    await runner.run();
    const err = events.find((e) => e.type === "error") as { type: string; code: string } | undefined;
    expect(err?.code).toBe("ENV_MISSING");
    expect(deps.spawnBackend).not.toHaveBeenCalled();
  });
});
