import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// ---- mock node:child_process（spawn/execFile）----
const spawnMock = vi.fn();
const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { ProcessSupervisor } from "../processes";

interface FakeProc {
  pid: number;
  stdin: { end: ReturnType<typeof vi.fn> };
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  emitter: EventEmitter;
  emitExit: (code: number) => void;
}

function makeFakeProc(pid: number): FakeProc {
  const emitter = new EventEmitter();
  const proc: FakeProc = {
    pid,
    stdin: { end: vi.fn() },
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    emitter,
    emitExit: (code) => emitter.emit("exit", code),
  };
  (proc as unknown as Record<string, unknown>).once = emitter.once.bind(emitter);
  (proc as unknown as Record<string, unknown>).on = emitter.on.bind(emitter);
  return proc;
}

beforeEach(() => {
  spawnMock.mockReset();
  execFileMock.mockReset();
  // promisify(execFile) 需要回调风格：成功回调 (null, {stdout,stderr})
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result?: unknown) => void;
    cb(null, { stdout: "", stderr: "" });
    return undefined as never;
  });
});

describe("processes: 进程所有权（D1 §18）", () => {
  it("spawnBackend 使用 venv python + windowsHide + detached + stdin 管道", () => {
    const fake = makeFakeProc(1111);
    spawnMock.mockReturnValue(fake);
    const sup = new ProcessSupervisor();
    const out = vi.fn();
    sup.spawnBackend({
      python: "C:\\stayops\\backend\\.venv\\Scripts\\python.exe",
      runner: "C:\\stayops\\backend\\scripts\\desktop_backend_runner.py",
      cwd: "C:\\stayops\\backend",
      host: "127.0.0.1",
      port: 8100,
      onOutput: out,
    });
    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toContain("python.exe");
    expect(args[0]).toContain("desktop_backend_runner.py");
    expect(opts).toMatchObject({
      cwd: "C:\\stayops\\backend",
      windowsHide: true,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(opts.env.STAYOPS_BACKEND_PORT).toBe("8100");
    expect(opts.env.STAYOPS_BACKEND_HOST).toBe("127.0.0.1");
    expect(sup.ownedPids()).toEqual({ backend: 1111 });
    expect(sup.isRunning("backend")).toBe(true);
  });

  it("spawnFrontend 设置 PORT/HOSTNAME/NODE_ENV 且只传 server.js", () => {
    const fake = makeFakeProc(2222);
    spawnMock.mockReturnValue(fake);
    const sup = new ProcessSupervisor();
    sup.spawnFrontend({
      nodeExe: "node",
      serverJs: "C:\\stayops\\frontend\\.next-desktop\\standalone\\server.js",
      cwd: "C:\\stayops\\frontend\\.next-desktop\\standalone",
      host: "127.0.0.1",
      port: 3100,
    });
    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("node");
    expect(args[0]).toContain("server.js");
    expect(opts.env.PORT).toBe("3100");
    expect(opts.env.HOSTNAME).toBe("127.0.0.1");
    expect(opts.env.NODE_ENV).toBe("production");
    expect(sup.ownedPids()).toEqual({ frontend: 2222 });
  });

  it("子进程退出后从所有权表移除并回调 onExit", () => {
    const fake = makeFakeProc(3333);
    spawnMock.mockReturnValue(fake);
    const sup = new ProcessSupervisor();
    const onExit = vi.fn();
    sup.spawnBackend({
      python: "py",
      runner: "runner.py",
      cwd: "cwd",
      host: "127.0.0.1",
      port: 8100,
      onExit,
    });
    fake.emitExit(0);
    expect(onExit).toHaveBeenCalledWith("backend", 0);
    expect(sup.hasChildren()).toBe(false);
  });

  it("输出流转发到 onOutput（scrub 由 logger 负责）", () => {
    const fake = makeFakeProc(4444);
    spawnMock.mockReturnValue(fake);
    const sup = new ProcessSupervisor();
    const out = vi.fn();
    sup.spawnBackend({
      python: "py",
      runner: "runner.py",
      cwd: "cwd",
      host: "127.0.0.1",
      port: 8100,
      onOutput: out,
    });
    fake.stdout.write("hello\n");
    expect(out).toHaveBeenCalledWith("hello\n");
  });
});

describe("processes: 优雅停机（D1 §19/§20）", () => {
  it("backend 优雅停机：关闭 stdin，不调用 taskkill（子进程正常退出）", async () => {
    const fake = makeFakeProc(5555);
    spawnMock.mockReturnValue(fake);
    const sup = new ProcessSupervisor();
    sup.spawnBackend({
      python: "py",
      runner: "runner.py",
      cwd: "cwd",
      host: "127.0.0.1",
      port: 8100,
    });
    const stopPromise = sup.stop("backend", { graceMs: 300, forceMs: 200 });
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.stdin.end).toHaveBeenCalledTimes(1);
    fake.emitExit(0);
    await stopPromise;
    expect(execFileMock).not.toHaveBeenCalled();
    expect(sup.hasChildren()).toBe(false);
  });

  it("backend 超时后强制 taskkill /T /F（只杀自己 PID）", async () => {
    const fake = makeFakeProc(6666);
    spawnMock.mockReturnValue(fake);
    const sup = new ProcessSupervisor();
    sup.spawnBackend({
      python: "py",
      runner: "runner.py",
      cwd: "cwd",
      host: "127.0.0.1",
      port: 8100,
    });
    await sup.stop("backend", { graceMs: 80, forceMs: 200 });
    const forceCall = execFileMock.mock.calls.find(
      (c) => c[0] === "taskkill" && c[1].includes("/F"),
    );
    expect(forceCall).toBeDefined();
    expect(forceCall![1]).toEqual(["/PID", "6666", "/T", "/F"]);
  });

  it("frontend 先 taskkill /T（优雅尝试）再 /T /F", async () => {
    const fake = makeFakeProc(7777);
    spawnMock.mockReturnValue(fake);
    const sup = new ProcessSupervisor();
    sup.spawnFrontend({
      nodeExe: "node",
      serverJs: "server.js",
      cwd: "cwd",
      host: "127.0.0.1",
      port: 3100,
    });
    await sup.stop("frontend", { graceMs: 80, forceMs: 200 });
    const calls = execFileMock.mock.calls
      .filter((c) => c[0] === "taskkill")
      .map((c) => c[1]);
    expect(calls[0]).toEqual(["/PID", "7777", "/T"]);
    expect(calls[1]).toEqual(["/PID", "7777", "/T", "/F"]);
  });

  it("stopAll 先前端后后端；重复 stop 幂等", async () => {
    const fakeB = makeFakeProc(8881);
    const fakeF = makeFakeProc(8882);
    spawnMock.mockReturnValueOnce(fakeB).mockReturnValueOnce(fakeF);
    const sup = new ProcessSupervisor();
    sup.spawnBackend({
      python: "py",
      runner: "runner.py",
      cwd: "cwd",
      host: "127.0.0.1",
      port: 8100,
    });
    sup.spawnFrontend({
      nodeExe: "node",
      serverJs: "server.js",
      cwd: "cwd",
      host: "127.0.0.1",
      port: 3100,
    });
    await sup.stopAll({ graceMs: 100, forceMs: 100 });
    // 子进程未响应：taskkill 顺序 = 先前端（优雅 /T）后后端（含 /F 兜底）
    const taskkillCalls = execFileMock.mock.calls
      .filter((c) => c[0] === "taskkill")
      .map((c) => c[1]);
    expect(taskkillCalls[0]).toEqual(["/PID", "8882", "/T"]);
    expect(taskkillCalls.at(-1)).toEqual(["/PID", "8881", "/T", "/F"]);
    // 仍未退出的子进程保留在所有权表（真实退出事件到达后才清理）
    expect(sup.hasChildren()).toBe(true);
    fakeF.emitExit(0);
    fakeB.emitExit(0);
    expect(sup.hasChildren()).toBe(false);
    // 重复 stop 幂等
    await sup.stopAll();
    expect(sup.hasChildren()).toBe(false);
  });

  it("已退出子进程 stop 时直接清理，不调用 taskkill", async () => {
    const fake = makeFakeProc(9999);
    spawnMock.mockReturnValue(fake);
    const sup = new ProcessSupervisor();
    sup.spawnBackend({
      python: "py",
      runner: "runner.py",
      cwd: "cwd",
      host: "127.0.0.1",
      port: 8100,
    });
    fake.emitExit(1);
    await sup.stop("backend");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(sup.hasChildren()).toBe(false);
  });
});
