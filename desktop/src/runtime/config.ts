/**
 * Desktop 运行时配置：端口、路径解析（纯函数，便于单元测试）。
 *
 * 两种运行模式（D2 foundation）：
 * - Development Mode（未打包）：从 StayOps 工作区解析（backend/.venv、
 *   workspace/runtime/postgres、workspace/frontend/.next-desktop/standalone），
 *   保持 D1 开发流程不变。
 * - Packaged Mode（安装版）：全部从 process.resourcesPath 解析
 *   （resources/{backend,python,postgres,node,scripts,frontend-server}），
 *   不要求工作区、AGENTS.md、backend/.venv 或 STAYOPS_ROOT。
 *
 * 约束：
 * - 桌面端口 8100/3100 仅绑定 127.0.0.1（与开发 8000/3000、E2E 8001/3001 互不冲突）。
 * - Electron 不读取任何 .env 秘密；DB/迁移检查全部经 Python 侧脚本完成。
 * - 程序文件与业务数据严格分离：程序在安装目录，数据在 %PROGRAMDATA%\StayOps。
 * - Packaged Mode 的 **PostgreSQL 执行路径**由 pgRuntime.ts materialize 到
 *   %PROGRAMDATA%\StayOps\runtime\postgresql\<version>\pgsql（ASCII-safe），
 *   以支持含中文/非 ASCII 的安装路径（alpha.9.6 hotfix）。
 */

import fs from "node:fs";
import path from "node:path";

export const DESKTOP_BACKEND_HOST = "127.0.0.1";
export const DESKTOP_FRONTEND_HOST = "127.0.0.1";
export const DESKTOP_BACKEND_PORT = 8100;
export const DESKTOP_FRONTEND_PORT = 3100;
/** StayOps 自带 PostgreSQL Runtime 端口（仅监听 127.0.0.1，与开发 Docker 5432 并存）。 */
export const DESKTOP_PG_PORT = 5433;
export const BACKEND_API_URL = `http://${DESKTOP_BACKEND_HOST}:${DESKTOP_BACKEND_PORT}`;
export const FRONTEND_URL = `http://${DESKTOP_FRONTEND_HOST}:${DESKTOP_FRONTEND_PORT}`;

export type RuntimeMode = "development" | "packaged";

/** bundled Python 可执行文件相对 resources/ 的位置。 */
export const BUNDLED_PYTHON_REL = path.join("python", "python.exe");
/** bundled Node 可执行文件相对 resources/ 的位置。 */
export const BUNDLED_NODE_REL = path.join("node", "node.exe");
/** bundled PostgreSQL bin 相对 resources/ 的位置。 */
export const BUNDLED_PG_BIN_REL = path.join("postgres", "pgsql", "bin");

/**
 * Packaged runtime layout 的结构校验（不依赖任何硬编码安装路径）：
 * resources/backend/app/main.py + resources/python/python.exe 必须存在。
 */
export function isPackagedRuntimeRoot(
  candidate: string,
  fsExists: (p: string) => boolean = fs.existsSync,
): boolean {
  try {
    return (
      fsExists(path.join(candidate, "backend", "app", "main.py")) &&
      fsExists(path.join(candidate, BUNDLED_PYTHON_REL))
    );
  } catch {
    return false;
  }
}

/**
 * 已安装 runtime 的候选根目录：Electron packaged 进程的 process.resourcesPath。
 * 开发模式下该目录不含 packed runtime layout，校验自然失败；
 * 由此**不需要**任何硬编码开发机路径（D2 security audit 要求）。
 */
export const KNOWN_WORKSPACE_CANDIDATES: readonly string[] = (() => {
  const resources: unknown = (process as { resourcesPath?: unknown }).resourcesPath;
  return typeof resources === "string" && resources.length > 0 ? [resources] : [];
})();

export interface DesktopPaths {
  /** development: 工作区根；packaged: resources/ 目录 */
  workspaceRoot: string;
  mode: RuntimeMode;
  backendDir: string;
  /** Python 可执行文件（development: backend/.venv；packaged: resources/python）。 */
  venvPython: string;
  scriptsDir: string;
  backendRunner: string;
  desktopProbe: string;
  frontendStandaloneDir: string;
  frontendServerJs: string;
  nodeExe: string;
  logsDir: string;
  trayIcon: string;
  appIcon: string;
  /** StayOps 自带 PostgreSQL Runtime（详见 docs/DECISIONS.md） */
  /** bundled runtime **源**目录（packaged: resources/postgres/pgsql） */
  pgBundledDir: string;
  /**
   * bundled runtime 的 bin 目录（安装完整性检查用）。
   * Packaged Mode 下**不再直接执行**：PG CLI 统一从
   * `pgRuntimeRootDir/<version>/pgsql/bin`（ASCII-safe materialized runtime）执行
   * —— 见 alpha.9.6 Windows non-ASCII hotfix 与 pgRuntime.ts。
   */
  pgBinDir: string;
  /** materialize 目标根：%PROGRAMDATA%\StayOps\runtime\postgresql（packaged 模式使用） */
  pgRuntimeRootDir: string;
  pgDataDir: string;
  pgCredsFile: string;
  /** 安装级配置目录（%PROGRAMDATA%\StayOps\config；不随程序升级/卸载删除） */
  configDir: string;
  /** 每台安装独立的 AI_ENCRYPTION_KEY 派生/存储位置（见 §8 security） */
  aiKeyFile: string;
  /** 首次安装 bootstrap 管理员凭据（DPAPI 保护；首次改密后销毁） */
  adminBootstrapFile: string;
  startupHtml: string;
}

export interface PathBuildOptions {
  isPackaged: boolean;
  resourcesPath?: string;
  /** 打包后应用根（app.getAppPath()，asar 内），用于定位启动窗口静态资源 */
  appPath?: string;
  localAppData?: string;
  nodeExe?: string;
  env?: NodeJS.ProcessEnv;
}

export interface WorkspaceCandidates {
  /** STAYOPS_ROOT 环境变量（最高优先级，可选调试通道） */
  envRoot?: string;
  /** 打包/开发环境已知候选路径 */
  known: readonly string[];
  /** 开发模式（未打包）：仓库根 = desktop/.. */
  devRoot?: string;
}

/**
 * 校验候选是否为可用 runtime 根：
 * - Development workspace：AGENTS.md + backend/.venv/Scripts/python.exe
 * - Packaged runtime：backend/app/main.py + python/python.exe
 */
export function isValidWorkspaceRoot(
  candidate: string,
  fsExists: (p: string) => boolean = fs.existsSync,
): boolean {
  try {
    const devWorkspace =
      fsExists(path.join(candidate, "AGENTS.md")) &&
      fsExists(path.join(candidate, "backend", ".venv", "Scripts", "python.exe"));
    return devWorkspace || isPackagedRuntimeRoot(candidate, fsExists);
  } catch {
    return false;
  }
}

/** 解析 runtime 根目录：STAYOPS_ROOT > 开发仓库根 > packaged resources。 */
export function resolveWorkspaceRoot(
  candidates: WorkspaceCandidates,
  fsExists: (p: string) => boolean = fs.existsSync,
): string | null {
  const list: string[] = [];
  if (candidates.envRoot) list.push(candidates.envRoot);
  if (candidates.devRoot) list.push(candidates.devRoot);
  list.push(...candidates.known);
  for (const candidate of list) {
    if (candidate && isValidWorkspaceRoot(candidate, fsExists)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

/** 构建桌面运行时路径集合（纯路径计算，不做 I/O 校验）。 */
export function buildPaths(
  workspaceRoot: string,
  opts: PathBuildOptions,
): DesktopPaths {
  const localAppData =
    opts.localAppData ?? process.env.LOCALAPPDATA ?? path.join(os_homedir(), "AppData", "Local");
  const packaged = opts.isPackaged;
  // 数据库数据目录与程序目录彻底分离（升级不触碰；%PROGRAMDATA%\StayOps）
  const programData = process.env.PROGRAMDATA ?? "C:\\ProgramData";
  const stayOpsData = path.join(programData, "StayOps");
  const pgHome = path.join(stayOpsData, "PostgreSQL");
  const configDir = path.join(stayOpsData, "config");
  const logsDir = path.join(localAppData, "StayOps", "logs");
  const pgDataDir = path.join(pgHome, "data");
  const pgCredsFile = path.join(pgHome, "conf", "dbpass.conf");
  // PostgreSQL runtime materialize 目标（ASCII-safe；与 data 目录、config 目录分离）
  const pgRuntimeRootDir = path.join(stayOpsData, "runtime", "postgresql");
  const aiKeyFile = path.join(configDir, "ai_encryption.key");
  const adminBootstrapFile = path.join(configDir, "admin-bootstrap.dat");

  if (packaged) {
    // Packaged Mode：全部来自 process.resourcesPath（安装目录内，真实文件系统）
    const resources = opts.resourcesPath ?? workspaceRoot;
    const app = opts.appPath ?? resources;
    const frontendStandaloneDir = path.join(resources, "frontend-server");
    return {
      workspaceRoot: resources,
      mode: "packaged",
      backendDir: path.join(resources, "backend"),
      venvPython: path.join(resources, BUNDLED_PYTHON_REL),
      scriptsDir: path.join(resources, "scripts"),
      backendRunner: path.join(
        resources,
        "backend",
        "scripts",
        "desktop_backend_runner.py",
      ),
      desktopProbe: path.join(resources, "scripts", "desktop_runtime.py"),
      frontendStandaloneDir,
      frontendServerJs: path.join(frontendStandaloneDir, "server.js"),
      nodeExe: opts.nodeExe ?? path.join(resources, BUNDLED_NODE_REL),
      logsDir,
      trayIcon: path.join(app, "assets", "tray.png"),
      appIcon: path.join(app, "assets", "app-icon.png"),
      pgBundledDir: path.join(resources, "postgres", "pgsql"),
      pgBinDir: path.join(resources, BUNDLED_PG_BIN_REL),
      pgRuntimeRootDir,
      pgDataDir,
      pgCredsFile,
      configDir,
      aiKeyFile,
      adminBootstrapFile,
      startupHtml: path.join(app, "src", "startup", "index.html"),
    };
  }

  // Development Mode：保持 D1 工作区布局不变
  const frontendStandaloneDir = path.join(
    workspaceRoot,
    "frontend",
    ".next-desktop",
    "standalone",
  );
  const desktopDir = path.join(workspaceRoot, "desktop");
  return {
    workspaceRoot,
    mode: "development",
    backendDir: path.join(workspaceRoot, "backend"),
    venvPython: path.join(workspaceRoot, "backend", ".venv", "Scripts", "python.exe"),
    scriptsDir: path.join(workspaceRoot, "scripts"),
    backendRunner: path.join(
      workspaceRoot,
      "backend",
      "scripts",
      "desktop_backend_runner.py",
    ),
    desktopProbe: path.join(workspaceRoot, "scripts", "desktop_runtime.py"),
    frontendStandaloneDir,
    frontendServerJs: path.join(frontendStandaloneDir, "server.js"),
    nodeExe: opts.nodeExe ?? process.env.STAYOPS_NODE ?? "node",
    logsDir,
    trayIcon: path.join(desktopDir, "assets", "tray.png"),
    appIcon: path.join(desktopDir, "assets", "app-icon.png"),
    pgBundledDir: path.join(workspaceRoot, "runtime", "postgres", "pgsql"),
    pgBinDir: path.join(workspaceRoot, "runtime", "postgres", "pgsql", "bin"),
    pgRuntimeRootDir,
    pgDataDir,
    pgCredsFile,
    configDir,
    aiKeyFile,
    adminBootstrapFile,
    startupHtml: path.join(desktopDir, "src", "startup", "index.html"),
  };
}

function os_homedir(): string {
  return process.env.USERPROFILE ?? "C:\\Users\\default";
}
