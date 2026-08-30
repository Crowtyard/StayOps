import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DESKTOP_BACKEND_PORT,
  DESKTOP_FRONTEND_PORT,
  KNOWN_WORKSPACE_CANDIDATES,
  buildPaths,
  isValidWorkspaceRoot,
  resolveWorkspaceRoot,
} from "../config";

function makeFakeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stayops-test-"));
  fs.mkdirSync(path.join(root, "backend", ".venv", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "backend", ".venv", "Scripts", "python.exe"), "");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# test");
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

  it("KNOWN_WORKSPACE_CANDIDATES 为非空且仅含当前机器路径（D1）", () => {
    expect(KNOWN_WORKSPACE_CANDIDATES.length).toBeGreaterThan(0);
    expect(KNOWN_WORKSPACE_CANDIDATES[0]).toContain("StayOps");
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

  it("打包模式无 appPath 时回退工作区 desktop 目录", () => {
    const root = makeFakeWorkspace();
    const p = buildPaths(root, { isPackaged: true, resourcesPath: "C:\\app\\resources" });
    expect(p.startupHtml).toBe(path.join(root, "desktop", "src", "startup", "index.html"));
    fs.rmSync(root, { recursive: true, force: true });
  });
});
