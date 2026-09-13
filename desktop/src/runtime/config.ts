/**
 * Desktop 运行时配置：端口、路径解析（纯函数，便于单元测试）。
 *
 * 约束（Desktop D1）：
 * - 桌面端口 8100/3100 仅绑定 127.0.0.1（与开发 8000/3000、E2E 8001/3001 互不冲突）。
 * - 前端 standalone 启动时由主进程注入 BACKEND_API_URL=http://127.0.0.1:8100
 *   （Next 16 服务端 Route Handler 运行时读取；DESKTOP_BACKEND_PORT 改动需同步
 *   main.ts 注入值）。
 * - Electron 不读取任何 .env 秘密；DB/迁移检查全部经 Python 侧脚本完成。
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

/** D1 已知工作区位置（当前机器）。可用环境变量 STAYOPS_ROOT 显式覆盖。 */
export const KNOWN_WORKSPACE_CANDIDATES: readonly string[] = [
  "D:\\MY SELF\\StayOps V1.0",
];

export interface DesktopPaths {
  workspaceRoot: string;
  backendDir: string;
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
  pgBinDir: string;
  pgDataDir: string;
  pgCredsFile: string;
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
  /** STAYOPS_ROOT 环境变量（最高优先级） */
  envRoot?: string;
  /** 打包/开发环境已知候选路径 */
  known: readonly string[];
  /** 开发模式（未打包）：仓库根 = desktop/.. */
  devRoot?: string;
}

/** 校验候选是否为合法 StayOps 工作区（存在 venv 与 AGENTS.md 标记）。 */
export function isValidWorkspaceRoot(
  candidate: string,
  fsExists: (p: string) => boolean = fs.existsSync,
): boolean {
  try {
    return (
      fsExists(path.join(candidate, "AGENTS.md")) &&
      fsExists(
        path.join(candidate, "backend", ".venv", "Scripts", "python.exe"),
      )
    );
  } catch {
    return false;
  }
}

/** 解析工作区根目录：STAYOPS_ROOT > 开发仓库根 > D1 已知路径。 */
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
  const resources = opts.resourcesPath ?? "";
  const frontendStandaloneDir = packaged
    ? path.join(resources, "frontend-server")
    : path.join(workspaceRoot, "frontend", ".next-desktop", "standalone");
  const desktopDir = path.join(workspaceRoot, "desktop");
  // 数据库数据目录与程序目录彻底分离（升级不触碰；%PROGRAMDATA%\StayOps）
  const programData = process.env.PROGRAMDATA ?? "C:\\ProgramData";
  const pgHome = path.join(programData, "StayOps", "PostgreSQL");
  return {
    workspaceRoot,
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
    logsDir: path.join(localAppData, "StayOps", "logs"),
    trayIcon: path.join(desktopDir, "assets", "tray.png"),
    appIcon: packaged
      ? path.join(opts.appPath ?? desktopDir, "assets", "app-icon.png")
      : path.join(desktopDir, "assets", "app-icon.png"),
    pgBinDir: path.join(workspaceRoot, "runtime", "postgres", "pgsql", "bin"),
    pgDataDir: path.join(pgHome, "data"),
    pgCredsFile: path.join(pgHome, "conf", "dbpass.conf"),
    startupHtml: packaged
      ? path.join(opts.appPath ?? desktopDir, "src", "startup", "index.html")
      : path.join(desktopDir, "src", "startup", "index.html"),
  };
}

function os_homedir(): string {
  return process.env.USERPROFILE ?? "C:\\Users\\default";
}
