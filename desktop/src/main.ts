/**
 * StayOps Desktop 主进程（Electron）。
 *
 * 职责（Desktop D1 §6/§7）：
 * - 桌面窗口 / 启动 UX / Runtime lifecycle / 本地进程监督；
 * - 不直接查询 PostgreSQL、不解析 Alembic（经 Python 探针）、
 *   不把 FastAPI 逻辑搬入 Electron；
 * - 单实例、托盘、IPC 白名单、导航防护、优雅停机。
 */

import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } from "electron";
import path from "node:path";

import {
  DESKTOP_BACKEND_PORT,
  DESKTOP_FRONTEND_PORT,
  FRONTEND_URL,
  KNOWN_WORKSPACE_CANDIDATES,
  buildPaths,
  resolveWorkspaceRoot,
  type DesktopPaths,
} from "./runtime/config";
import { IPC } from "./runtime/ipc";
import { ScrubFileLogger } from "./runtime/logger";
import { findOccupants, portInUse, resolveNodePath } from "./runtime/preflight";
import {
  dbCheck,
  migrationStatus,
  migrationUpgrade,
  type ProbeContext,
} from "./runtime/probe";
import { ProcessSupervisor } from "./runtime/processes";
import { StartupRunner, type StartupEvent } from "./runtime/startup";

// ---------------------------------------------------------------------------
// 单实例（D1 §17）：第二次启动只 restore + focus 已有窗口
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

let paths: DesktopPaths;
let logger: ScrubFileLogger;
let supervisor = new ProcessSupervisor();
let runner: StartupRunner | null = null;
let startupWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 事件日志：启动窗口加载完成后回放（最多保留最近 100 条）。 */
const eventLog: StartupEvent[] = [];
let quitting = false;

const CORE_ROUTES = [
  "/api/v1/rooms",
  "/api/v1/reservations",
  "/api/v1/housekeeping/tasks",
  "/api/v1/maintenance/orders",
];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 启动窗口
// ---------------------------------------------------------------------------

function createStartupWindow(): void {
  startupWindow = new BrowserWindow({
    width: 560,
    height: 660,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "StayOps 正在启动",
    backgroundColor: "#f4f5f7",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  startupWindow.once("ready-to-show", () => {
    startupWindow?.show();
  });
  startupWindow.on("closed", () => {
    startupWindow = null;
  });
  void startupWindow.loadFile(paths.startupHtml);
}

function emitStartupEvent(event: StartupEvent): void {
  eventLog.push(event);
  if (eventLog.length > 100) eventLog.shift();
  logger.write("STARTUP", JSON.stringify(event));
  if (event.type === "ready") {
    // Runtime Ready：关闭启动窗口，打开正式应用窗口
    logger.write("MAIN", `Runtime ready: ${event.backendUrl} / ${event.frontendUrl}`);
    createMainWindow();
    if (startupWindow && !startupWindow.isDestroyed()) {
      startupWindow.destroy();
      startupWindow = null;
    }
    return;
  }
  if (startupWindow && !startupWindow.isDestroyed()) {
    startupWindow.webContents.send(IPC.Events, event);
  }
}

// ---------------------------------------------------------------------------
// 主窗口（正式应用）
// ---------------------------------------------------------------------------

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "StayOps",
    backgroundColor: "#f8fafc",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 正式应用窗口不需要 preload：Next.js 应用只走 HTTP/BFF
    },
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 导航防护（D1 §22）：只允许应用自身 origin；外部 URL 走系统浏览器
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(FRONTEND_URL)) {
      event.preventDefault();
      openExternalSafe(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: "deny" };
  });

  void mainWindow.loadURL(FRONTEND_URL);
  logger.write("MAIN", `main window -> ${FRONTEND_URL}`);
}

function openExternalSafe(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      void shell.openExternal(url);
    }
  } catch {
    // 非法 URL 忽略
  }
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else if (startupWindow && !startupWindow.isDestroyed()) {
    startupWindow.show();
    startupWindow.focus();
  }
}

// ---------------------------------------------------------------------------
// 托盘（D1 §24）
// ---------------------------------------------------------------------------

function createTray(): void {
  const icon = nativeImage.createFromPath(paths.trayIcon);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("StayOps");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 StayOps", click: () => showMainWindow() },
      { label: "打开日志目录", click: () => void shell.openPath(logger.logsDirPath()) },
      { type: "separator" },
      { label: "退出 StayOps", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => showMainWindow());
}

// ---------------------------------------------------------------------------
// Runtime 探测 / 就绪
// ---------------------------------------------------------------------------

function probeContext(): ProbeContext {
  return {
    python: paths.venvPython,
    probeScript: paths.desktopProbe,
    cwd: paths.backendDir,
    backendPort: DESKTOP_BACKEND_PORT,
    frontendPort: DESKTOP_FRONTEND_PORT,
  };
}

async function waitHttp(url: string, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastNote = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        cache: "no-store",
      });
      if (res.status === 200) return true;
      const now = Date.now();
      if (now - lastNote > 10_000) {
        lastNote = now;
        logger.write("READY", `${label} 尚未就绪（HTTP ${res.status}）…`);
      }
    } catch {
      const now = Date.now();
      if (now - lastNote > 10_000) {
        lastNote = now;
        logger.write("READY", `${label} 尚未就绪（无响应）…`);
      }
    }
    await sleep(1200);
  }
  return false;
}

async function checkCoreRoutes(backendUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${backendUrl}/openapi.json`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const spec = (await res.json()) as { paths?: Record<string, unknown> };
    const routePaths = Object.keys(spec.paths ?? {});
    return CORE_ROUTES.every((route) =>
      routePaths.some((p) => p === route || p.startsWith(`${route}/`)),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 启动编排
// ---------------------------------------------------------------------------

async function bootstrap(workspaceRoot: string | null): Promise<void> {
  logger.write(
    "MAIN",
    `StayOps Desktop ${app.getVersion()} starting (packaged=${app.isPackaged})`,
  );

  if (!workspaceRoot) {
    emitStartupEvent({
      type: "error",
      code: "ENV_MISSING",
      message: "找不到 StayOps 工作区",
      detail:
        "请确认本机存在 StayOps 工作区（backend/.venv），\n或设置环境变量 STAYOPS_ROOT 指向工作区根目录。",
    });
    return;
  }

  logger.write("MAIN", `workspace: ${paths.workspaceRoot}`);

  const ctx = probeContext();
  const backendStream = logger.streamWriter("backend");
  const frontendStream = logger.streamWriter("frontend");

  runner = new StartupRunner({
    paths,
    supervisor,
    findOccupants: () =>
      findOccupants([
        { label: "backend", port: DESKTOP_BACKEND_PORT },
        { label: "frontend", port: DESKTOP_FRONTEND_PORT },
      ]),
    dbCheck: () => dbCheck(ctx),
    migrationStatus: () => migrationStatus(ctx),
    migrationUpgrade: () => migrationUpgrade(ctx),
    spawnBackend: () =>
      supervisor.spawnBackend({
        python: paths.venvPython,
        runner: paths.backendRunner,
        cwd: paths.backendDir,
        host: "127.0.0.1",
        port: DESKTOP_BACKEND_PORT,
        onOutput: (text) => backendStream.write(text),
        onExit: (label, code) => logger.write("PROC", `${label} exited code=${code}`),
      }),
    spawnFrontend: () => {
      void resolveNodePath(paths.nodeExe).then((resolved) => {
        if (!resolved) {
          logger.write(
            "PROC",
            `WARNING 未找到 node（${paths.nodeExe}）；前端启动可能失败`,
          );
        }
      });
      return supervisor.spawnFrontend({
        nodeExe: paths.nodeExe,
        serverJs: paths.frontendServerJs,
        cwd: paths.frontendStandaloneDir,
        host: "127.0.0.1",
        port: DESKTOP_FRONTEND_PORT,
        // Next 16 在运行时读取 BACKEND_API_URL（服务端 Route Handler），
        // standalone 启动时必须显式注入桌面后端地址
        env: {
          BACKEND_API_URL: `http://127.0.0.1:${DESKTOP_BACKEND_PORT}`,
        },
        onOutput: (text) => frontendStream.write(text),
        onExit: (label, code) => logger.write("PROC", `${label} exited code=${code}`),
      });
    },
    waitHttp,
    checkCoreRoutes,
    resolveNode: () => resolveNodePath(paths.nodeExe),
    tailLog: (label, lines) => logger.tail(label, lines),
    onEvent: emitStartupEvent,
  });

  ipcMain.handle(IPC.GetState, () => eventLog.slice(-100));
  ipcMain.handle(IPC.Retry, async () => {
    logger.write("MAIN", "user requested retry");
    await runner?.retry();
  });
  ipcMain.handle(IPC.MigrationUpgrade, async () => {
    logger.write("MAIN", "user confirmed migration upgrade");
    await runner?.upgrade();
  });
  ipcMain.handle(IPC.OpenLogs, async () => {
    void shell.openPath(logger.logsDirPath());
  });
  ipcMain.handle(IPC.Quit, () => app.quit());

  createTray();
  await runner.run();
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

if (gotLock) {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      logger?.write("MAIN", "shutting down…");
      try {
        await runner?.stop();
      } catch (err) {
        logger?.write("STOP", `stop error: ${String(err)}`);
      }
      await sleep(500);
      for (const [label, port] of [
        ["backend", DESKTOP_BACKEND_PORT],
        ["frontend", DESKTOP_FRONTEND_PORT],
      ] as const) {
        const busy = await portInUse("127.0.0.1", port);
        logger?.write("STOP", busy ? `WARNING ${label} 端口 ${port} 仍被占用` : `${label} 端口 ${port} 已释放`);
      }
      app.exit(0);
    })();
  });

  app.whenReady().then(async () => {
    logger = new ScrubFileLogger(
      path.join(
        process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local"),
        "StayOps",
        "logs",
      ),
    );
    logger.ensureDir();
    const workspaceRoot = resolveWorkspaceRoot({
      envRoot: process.env.STAYOPS_ROOT,
      devRoot: app.isPackaged ? undefined : path.resolve(__dirname, "..", ".."),
      known: KNOWN_WORKSPACE_CANDIDATES,
    });
    paths = buildPaths(workspaceRoot ?? "", {
      isPackaged: app.isPackaged,
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      appPath: app.isPackaged ? app.getAppPath() : undefined,
    });
    createStartupWindow();
    await bootstrap(workspaceRoot);
  });
}
