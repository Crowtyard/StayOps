import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { promisify } from "node:util";
import { findOccupants, pidForPort, portInUse, resolveNodePath } from "../preflight";

// ---- child_process mock：默认走真实实现；失败路径用 mockImplementationOnce ----
const execFileMock = vi.hoisted(() => vi.fn());
const realExecFile = vi.hoisted(
  () => ({ fn: undefined as unknown as (...args: unknown[]) => unknown }),
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  realExecFile.fn = actual.execFile;
  const mocked = (...args: unknown[]) => execFileMock(...args);
  // 自定义 promisify 实现（路由经过 execFileMock，供失败路径注入）：
  // 与 Node 原生 execFile 的 promisify.custom 行为一致（resolve {stdout, stderr}）
  mocked[promisify.custom] = (
    file: string,
    args: readonly string[],
    options: object,
  ) =>
    new Promise((resolve, reject) => {
      execFileMock(file, args, options, (err: Error | null, stdout?: string, stderr?: string) => {
        if (err) reject(err);
        else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      });
    });
  return { ...actual, execFile: mocked };
});

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((...args: unknown[]) =>
    realExecFile.fn(...args),
  );
});

// 真实 socket 探测（读路径，无副作用）
describe("preflight: 端口探测（只读，不杀进程）", () => {
  let server: net.Server | null = null;
  let boundPort = 0;

  afterAll(() => {
    server?.close();
  });

  it("已监听端口返回占用", async () => {
    server = net.createServer();
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server!.address() as net.AddressInfo;
    boundPort = address.port;
    expect(boundPort).toBeGreaterThan(0);
    expect(await portInUse("127.0.0.1", boundPort)).toBe(true);
  });

  it("空闲端口返回未占用", async () => {
    const freePort = await findFreePort();
    expect(freePort).toBeGreaterThan(0);
    expect(await portInUse("127.0.0.1", freePort)).toBe(false);
  });

  it("pidForPort 能解析真实监听进程 PID", async () => {
    const pid = await pidForPort(boundPort);
    // 本测试进程自己监听的端口 → PID 应为当前进程
    expect(pid).toBe(String(process.pid));
  });

  it("findOccupants 只报告占用项", async () => {
    const freePort = await findFreePort();
    const occupied = await findOccupants([
      { label: "backend", port: boundPort },
      { label: "frontend", port: freePort },
    ]);
    expect(occupied).toHaveLength(1);
    expect(occupied[0]!.label).toBe("backend");
    expect(occupied[0]!.port).toBe(boundPort);
  });

  it("netstat 失败时 pidForPort 返回 null（不抛错）", async () => {
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      cb(new Error("boom"));
      return undefined as never;
    });
    expect(await pidForPort(boundPort)).toBeNull();
  });
});

async function findFreePort(): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const candidate = 40000 + Math.floor(Math.random() * 20000);
    if (!(await portInUse("127.0.0.1", candidate))) return candidate;
  }
  throw new Error("no free port found");
}

describe("preflight: node 解析", () => {
  it("显式指定路径直接返回", async () => {
    expect(await resolveNodePath("C:\\node\\node.exe")).toBe("C:\\node\\node.exe");
  });

  it("默认 node 经 where 解析；失败返回 null", async () => {
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      cb(null, "C:\\Program Files\\nodejs\\node.exe\n", "");
      return undefined as never;
    });
    expect(await resolveNodePath("node")).toBe("C:\\Program Files\\nodejs\\node.exe");
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      cb(new Error("where failed"));
      return undefined as never;
    });
    expect(await resolveNodePath("node")).toBeNull();
  });
});
