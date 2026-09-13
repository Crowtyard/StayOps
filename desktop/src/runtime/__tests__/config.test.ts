import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUNDLED_PYTHON_REL,
  DESKTOP_BACKEND_PORT,
  DESKTOP_FRONTEND_PORT,
  KNOWN_WORKSPACE_CANDIDATES,
  buildPaths,
  isPackagedRuntimeRoot,
  isValidWorkspaceRoot,
  resolveWorkspaceRoot,
} from "../config";

const PROGRAM_DATA = process.env.PROGRAMDATA ?? "C:\\ProgramData";

function makeFakeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stayops-test-"));
  fs.mkdirSync(path.join(root, "backend", ".venv", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "backend", ".venv", "Scripts", "python.exe"), "");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# test");
  return root;
}

/** 构造 packed runtime layout（resources/backend + resources/python）。 */
function makeFakePackagedRuntime(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stayops-packaged-"));
  fs.mkdirSync(path.join(root, "backend", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "backend", "app", "main.py"), "");
  fs.mkdirSync(path.dirname(path.join(root, BUNDLED_PYTHON_REL)), { recursive: true });
  fs.writeFileSync(path.join(root, BUNDLED_PYTHON_REL), "");
  return root;
}

describe("config: 端口常量（Desktop D1 §14）", () => {
  it("桌面端口固定 8100/3100，与开发 8000/3000、E2E 8001/3001 不冲突", () => {
    expect(DESKTOP_BACKEND_PORT).toBe(8100);
    expect(DESKTOP_FRONTEND_PORT).toBe(3100);
    expect([8000, 3000, 8001, 3001, 8099]).not.toContain(DESKTOP_BACKEND_PORT);
    expect([8000, 3000, 8001, 3001, 8099]).not.toContain(DESKTOP_FRONTEND_PORT);
  });
});

describe("config: workspace 解析", () => {
  it("识别合法工作区（AGENTS.md + venv python.exe）", () => {
    const root = makeFakeWorkspace();
    expect(isValidWorkspaceRoot(root)).toBe(true);
    expect(
      resolveWorkspaceRoot({ known: [root] }),
    ).toBe(path.resolve(root));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("缺少 venv 标记的目录不是合法工作区", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stayops-test-"));
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# x");
    expect(isValidWorkspaceRoot(root)).toBe(false);
    expect(resolveWorkspaceRoot({ known: [root] })).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("STAYOPS_ROOT 环境变量优先于已知候选", () => {
    const rootA = makeFakeWorkspace();
    const rootB = makeFakeWorkspace();
    expect(
      resolveWorkspaceRoot({ envRoot: rootB, known: [rootA] }),
    ).toBe(path.resolve(rootB));
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it("devRoot（开发仓库根）优先于 D1 已知路径", () => {
    const rootA = makeFakeWorkspace();
    const rootB = makeFakeWorkspace();
    expect(
      resolveWorkspaceRoot({ devRoot: rootB, known: [rootA] }),
    ).toBe(path.resolve(rootB));
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it("全部候选无效时返回 null", () => {
    expect(resolveWorkspaceRoot({ known: ["C:\\nonexistent-stayops"] })).toBeNull();
  });

  it("KNOWN_WORKSPACE_CANDIDATES 无硬编码开发机路径（D2 security）", () => {
    // Electron packaged 进程提供 process.resourcesPath；纯 Node（vitest）下为空。
    // 关键断言：不再包含任何硬编码开发机绝对路径。
    for (const candidate of KNOWN_WORKSPACE_CANDIDATES) {
      expect(candidate).not.toContain("MY SELF");
      expect(candidate.toUpperCase()).not.toContain("CROWTYARD");
    }
    expect(KNOWN_WORKSPACE_CANDIDATES.every((c) => c === process.resourcesPath)).toBe(true);
  });

  it("packaged runtime layout 可被识别为合法 runtime 根（无需 AGENTS.md / .venv）", () => {
    const root = makeFakePackagedRuntime();
    expect(isPackagedRuntimeRoot(root)).toBe(true);
    expect(isValidWorkspaceRoot(root)).toBe(true);
    expect(resolveWorkspaceRoot({ known: [root], devRoot: undefined })).toBe(path.resolve(root));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("config: buildPaths", () => {
  it("开发模式：standalone 与日志目录解析正确", () => {
    const root = makeFakeWorkspace();
    const p = buildPaths(root, {
      isPackaged: false,
      localAppData: "C:\\Users\\t\\AppData\\Local",
      nodeExe: "node",
    });
    expect(p.venvPython).toBe(path.join(root, "backend", ".venv", "Scripts", "python.exe"));
    expect(p.backendRunner).toContain("desktop_backend_runner.py");
    expect(p.desktopProbe).toContain("scripts" + path.sep + "desktop_runtime.py");
    expect(p.frontendStandaloneDir).toBe(
      path.join(root, "frontend", ".next-desktop", "standalone"),
    );
    expect(p.frontendServerJs.endsWith(path.join("standalone", "server.js"))).toBe(true);
    expect(p.logsDir).toBe("C:\\Users\\t\\AppData\\Local\\StayOps\\logs");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("打包模式：standalone 来自 resources/frontend-server，startupHtml 来自 asar", () => {
    const root = makeFakeWorkspace();
    const p = buildPaths(root, {
      isPackaged: true,
      resourcesPath: "C:\\app\\resources",
      appPath: "C:\\app\\resources\\app.asar",
    });
    expect(p.frontendStandaloneDir).toBe("C:\\app\\resources\\frontend-server");
    expect(p.startupHtml).toBe(
      path.join("C:\\app\\resources\\app.asar", "src", "startup", "index.html"),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("打包模式无 appPath 时回退 resources 根（不依赖工作区）", () => {
    const root = makeFakeWorkspace();
    const p = buildPaths(root, { isPackaged: true, resourcesPath: "C:\\app\\resources" });
    expect(p.startupHtml).toBe(
      path.join("C:\\app\\resources", "src", "startup", "index.html"),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("打包模式：runtime 全部来自 resources（不依赖工作区/.venv/STAYOPS_ROOT）", () => {
    const root = makeFakeWorkspace();
    const resources = "C:\\app\\resources";
    const app = "C:\\app\\resources\\app.asar";
    const p = buildPaths(root, {
      isPackaged: true,
      resourcesPath: resources,
      appPath: app,
      localAppData: "C:\\Users\\t\\AppData\\Local",
    });
    expect(p.mode).toBe("packaged");
    expect(p.workspaceRoot).toBe(resources);
    expect(p.backendDir).toBe(path.join(resources, "backend"));
    expect(p.venvPython).toBe(path.join(resources, "python", "python.exe"));
    expect(p.backendRunner).toBe(
      path.join(resources, "backend", "scripts", "desktop_backend_runner.py"),
    );
    expect(p.desktopProbe).toBe(path.join(resources, "scripts", "desktop_runtime.py"));
    expect(p.nodeExe).toBe(path.join(resources, "node", "node.exe"));
    expect(p.pgBinDir).toBe(path.join(resources, "postgres", "pgsql", "bin"));
    expect(p.frontendStandaloneDir).toBe(path.join(resources, "frontend-server"));
    expect(p.trayIcon).toBe(path.join(app, "assets", "tray.png"));
    expect(p.appIcon).toBe(path.join(app, "assets", "app-icon.png"));
    expect(p.startupHtml).toBe(path.join(app, "src", "startup", "index.html"));
    // 数据/配置/日志与程序目录彻底分离
    expect(p.pgDataDir).toBe(path.join(PROGRAM_DATA, "StayOps", "PostgreSQL", "data"));
    expect(p.pgCredsFile).toBe(
      path.join(PROGRAM_DATA, "StayOps", "PostgreSQL", "conf", "dbpass.conf"),
    );
    expect(p.configDir).toBe(path.join(PROGRAM_DATA, "StayOps", "config"));
    expect(p.aiKeyFile).toBe(
      path.join(PROGRAM_DATA, "StayOps", "config", "ai_encryption.key"),
    );
    expect(p.logsDir).toBe("C:\\Users\\t\\AppData\\Local\\StayOps\\logs");
    // 不含任何工作区路径
    expect(JSON.stringify(p)).not.toContain(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("开发模式：mode=development 且不触碰 packaged runtime 路径", () => {
    const root = makeFakeWorkspace();
    const p = buildPaths(root, {
      isPackaged: false,
      localAppData: "C:\\Users\\t\\AppData\\Local",
      nodeExe: "node",
    });
    expect(p.mode).toBe("development");
    expect(p.workspaceRoot).toBe(root);
    expect(p.trayIcon).toBe(path.join(root, "desktop", "assets", "tray.png"));
    expect(p.pgBinDir).toBe(path.join(root, "runtime", "postgres", "pgsql", "bin"));
    fs.rmSync(root, { recursive: true, force: true });
  });
});
