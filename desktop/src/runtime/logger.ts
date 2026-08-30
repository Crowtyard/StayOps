/**
 * 桌面日志：%LOCALAPPDATA%\StayOps\logs\{desktop,backend,frontend}.log
 *
 * - 全部输出先过 scrub（DATABASE_URL 密码 / sk-* Key / AI_ENCRYPTION_KEY /
 *   Authorization 等），不污染 Git workspace。
 * - 子进程 stdout/stderr 以「行缓冲 + 时间戳前缀」写入对应日志文件。
 */

import { Transform } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { scrubText } from "./scrub";

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class ScrubFileLogger {
  constructor(private readonly logsDir: string) {}

  ensureDir(): void {
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  private filePath(label: string): string {
    return path.join(this.logsDir, `${label}.log`);
  }

  /** 主进程自身日志（desktop.log）。 */
  write(section: string, message: string): void {
    this.ensureDir();
    const line = `[${timestamp()}] [${section}] ${scrubText(message).trimEnd()}\n`;
    try {
      fs.appendFileSync(this.filePath("desktop"), line, "utf8");
    } catch {
      // 日志失败不影响运行（仅诊断用途）
    }
  }

  /**
   * 子进程输出流目标：行缓冲 + scrub + 时间戳前缀，
   * 按 label 写入 backend.log / frontend.log。
   */
  streamWriter(label: string): Writable {
    this.ensureDir();
    const filePath = this.filePath(label);
    let buffer = "";
    return new Transform({
      transform(chunk: Buffer | string, _encoding, callback) {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        const text = scrubText(lines.join("\n"));
        if (text.trim().length > 0) {
          try {
            fs.appendFileSync(
              filePath,
              text
                .split("\n")
                .filter((l) => l.trim().length > 0)
                .map((l) => `[${timestamp()}] [${label}] ${l.trimEnd()}`)
                .join("\n") + "\n",
              "utf8",
            );
          } catch {
            // ignore
          }
        }
        callback();
      },
      flush(callback) {
        if (buffer.trim().length > 0) {
          try {
            fs.appendFileSync(
              filePath,
              `[${timestamp()}] [${label}] ${buffer.trimEnd()}\n`,
              "utf8",
            );
          } catch {
            // ignore
          }
        }
        buffer = "";
        callback();
      },
    });
  }

  /** 读取某日志最后 N 行（错误详情用；已 scrub 存储）。 */
  tail(label: string, lines = 15): string {
    try {
      const content = fs.readFileSync(this.filePath(label), "utf8");
      const all = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      return all.slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  logsDirPath(): string {
    return this.logsDir;
  }
}
