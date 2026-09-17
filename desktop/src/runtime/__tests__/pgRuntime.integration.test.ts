/**
 * 真实集成测试（默认跳过；alpha.9.6 Windows runtime hotfix）。
 *
 * 运行方式（Windows，需要本地已有 EDB PostgreSQL runtime）：
 *
 *   $env:STAYOPS_PG_INTEGRATION = "1"
 *   cd desktop; npx vitest run src/runtime/__tests__/pgRuntime.integration.test.ts
 *
 * 验证用户要求的真实链路：
 *   1. 把 bundled PostgreSQL runtime 放到**含中文的** resources 路径
 *      （默认 `D:\测试目录\StayOps\resources\postgres\pgsql`）
 *   2. materialize 到 ASCII-safe 的
 *      `C:\ProgramData\StayOps\runtime\postgresql\<version>\pgsql`
 *   3. 用 materialized runtime 执行**真实** `initdb -E UTF8 --locale=C` → 必须 PASS
 *
 * 背景：直接从非 ASCII 安装路径执行 initdb 会失败
 * （`FATAL: invalid byte sequence for encoding "UTF8": 0xb0`），
 * 因此该测试同时断言「源路径确实非 ASCII」与「执行路径确实 ASCII-safe」，
 * 否则测试本身没有意义。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ensurePgRuntime, isAsciiSafePath, readMarker } from "../pgRuntime";

const workspace = path.resolve(process.cwd(), "..");
const localRuntime = path.join(workspace, "runtime", "postgres", "pgsql");

/**
 * PG CLI 输出的稳健解码（与产品侧 `decode_pg_output` 同策略）：
 * UTF-8 → Windows ANSI codepage（gbk/cp936）→ replacement。
 */
function decodePgText(raw: Buffer): string {
  if (raw.length === 0) return "";
  const utf8 = raw.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  for (const encoding of ["gbk", "cp936", "cp1252"]) {
    try {
      return new TextDecoder(encoding).decode(raw);
    } catch {
      // 该编码不可用则继续尝试
    }
  }
  return utf8;
}

const enabled =
  process.platform === "win32" && process.env.STAYOPS_PG_INTEGRATION === "1";

const sourceStage =
  process.env.STAYOPS_PG_INTEGRATION_SOURCE ??
  "D:\\测试目录\\StayOps\\resources\\postgres\\pgsql";
const runtimeRoot =
  process.env.STAYOPS_PG_INTEGRATION_ROOT ??
  path.join("C:\\ProgramData", "StayOps", "runtime", "postgresql");

const skipReason = enabled
  ? fs.existsSync(path.join(localRuntime, "bin", "postgres.exe"))
    ? null
    : `本地缺少 PostgreSQL runtime：${localRuntime}`
  : "设置 STAYOPS_PG_INTEGRATION=1 才运行真实 materialize/initdb 集成测试";

const scratch = path.join(os.tmpdir(), "stayops-pg-integration");

afterAll(() => {
  // 清理测试自身产生的目录（stage 源 / materialized runtime / scratch 数据目录）
  for (const target of [sourceStage, runtimeRoot, scratch]) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结论
    }
  }
});

describe("pgRuntime integration · 中文源路径 → ASCII-safe runtime → 真实 initdb", () => {
  it.skipIf(Boolean(skipReason))(
    "materialize 后真实 initdb -E UTF8 --locale=C 成功",
    () => {
      // 1) 把 bundled runtime 放到含中文的 resources 路径（模拟中文安装目录）
      fs.rmSync(sourceStage, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(sourceStage), { recursive: true });
      fs.cpSync(localRuntime, sourceStage, { recursive: true });
      const stagedPostgres = path.join(sourceStage, "bin", "postgres.exe");
      expect(fs.existsSync(stagedPostgres)).toBe(true);
      expect(isAsciiSafePath(sourceStage)).toBe(false);

      // 记录 build 期 marker（真实安装包由 bundle-runtimes.mjs 写入）
      const versionOut = execFileSync(stagedPostgres, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim();
      const version = /(\d+)\.(\d+)/.exec(versionOut);
      expect(version).not.toBeNull();
      const pgVersion = version ? `${version[1]}.${version[2]}` : "unknown";
      fs.writeFileSync(
        path.join(sourceStage, ".stayops-runtime.json"),
        `${JSON.stringify({ schema: 1, version: pgVersion }, null, 2)}\n`,
        "utf8",
      );

      // 2) materialize 到 ASCII-safe 版本化路径
      const result = ensurePgRuntime({
        mode: "packaged",
        bundledPgDir: sourceStage,
        devBinDir: path.join(sourceStage, "bin"),
        runtimeRootDir: runtimeRoot,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.version).toBe(pgVersion);
      expect(result.binDir).toBe(
        path.join(runtimeRoot, pgVersion, "pgsql", "bin"),
      );
      expect(isAsciiSafePath(result.binDir)).toBe(true);
      expect(readMarker(path.dirname(result.binDir))?.version).toBe(pgVersion);

      // 幂等复用：再次解析不重新复制
      const again = ensurePgRuntime({
        mode: "packaged",
        bundledPgDir: sourceStage,
        devBinDir: path.join(sourceStage, "bin"),
        runtimeRootDir: runtimeRoot,
      });
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.action).toBe("reused");

      // 3) 用 materialized runtime 执行真实 initdb（UTF8 + locale=C）
      const dataDir = path.join(scratch, "pgdata");
      fs.rmSync(scratch, { recursive: true, force: true });
      fs.mkdirSync(dataDir, { recursive: true });
      const pwfile = path.join(scratch, "pw.txt");
      fs.writeFileSync(pwfile, "IntegrationTest-Passw0rd!\n", "utf8");

      let initdbCode = 0;
      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      try {
        stdoutBuf = execFileSync(
          path.join(result.binDir, "initdb.exe"),
          [
            "-D",
            dataDir,
            "-U",
            "stayops",
            "-A",
            "scram-sha-256",
            `--pwfile=${pwfile}`,
            "-E",
            "UTF8",
            "--locale=C",
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            timeout: 180_000,
            maxBuffer: 16 * 1024 * 1024,
          },
        );
      } catch (err) {
        const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
        initdbCode = e.status ?? 1;
        stdoutBuf = e.stdout ?? Buffer.alloc(0);
        stderrBuf = e.stderr ?? Buffer.alloc(0);
      }
      const initdbOut = `${decodePgText(stdoutBuf)}\n${decodePgText(stderrBuf)}`;

      expect(initdbCode, `initdb 失败输出：\n${initdbOut}`).toBe(0);
      expect(fs.existsSync(path.join(dataDir, "PG_VERSION"))).toBe(true);
      // initdb 的成功提示在输出尾部（本地化语言随系统：Success / 成功）
      expect(initdbOut).toMatch(/Success|成功/);
      // 输出中的 pg_ctl 提示必须指向 materialized 的 ASCII-safe runtime
      // （initdb 会为 cmd 转义路径，比较前去掉 ^ 转义符），
      // 且文本可读（中文 Windows 下不再出现 ANSI codepage 乱码）
      const hint = initdbOut.replace(/\^/g, "");
      expect(hint).toContain(`runtime\\postgresql\\${pgVersion}\\pgsql`);
      expect(hint).not.toContain(sourceStage.replace(/\//g, "\\"));
      expect(initdbOut).not.toContain("\uFFFD");
    },
    600_000,
  );
});
