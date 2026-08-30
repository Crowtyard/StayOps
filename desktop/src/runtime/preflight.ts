/**
 * 端口预检与运行时解析（只读探测，绝不杀进程）。
 *
 * D1 §14/§28：端口被未知进程占用 → 显式报错（显示 PID），
 * 禁止 kill by port / kill unknown PID。
 */

import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OccupiedPort {
  label: string;
  port: number;
  pid: string | null;
}

/** TCP 连接探测：端口是否已被监听（127.0.0.1 视角）。 */
export function portInUse(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/** 查询监听指定端口的 PID（netstat 只读解析，不杀进程）。 */
export async function pidForPort(port: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], {
      windowsHide: true,
    });
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const address = parts[1] ?? "";
      if (address.endsWith(`:${port}`) && parts[3] === "LISTENING") {
        return parts[4] ?? null;
      }
    }
  } catch {
    // netstat 不可用/失败时返回 null（调用方给出通用错误）
  }
  return null;
}

/** 批量端口占用检查。 */
export async function findOccupants(
  ports: ReadonlyArray<{ label: string; port: number }>,
): Promise<OccupiedPort[]> {
  const occupied: OccupiedPort[] = [];
  for (const { label, port } of ports) {
    if (await portInUse("127.0.0.1", port)) {
      occupied.push({ label, port, pid: await pidForPort(port) });
    }
  }
  return occupied;
}

/** 解析 node 可执行文件路径（`where node`），失败返回 null。 */
export async function resolveNodePath(nodeExe: string): Promise<string | null> {
  if (nodeExe !== "node") {
    // 显式指定路径：直接信任（启动阶段会实测 --version）
    return nodeExe;
  }
  try {
    const { stdout } = await execFileAsync("where", ["node"], { windowsHide: true });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}
