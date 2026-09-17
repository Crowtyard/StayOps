/**
 * PostgreSQL runtime resolver / materialization 测试（alpha.9.6 Windows hotfix）。
 *
 * 覆盖 docs/DECISIONS.md 中列出的 materialization 安全要求：
 * versioned dir / staging / 复制后校验 / 原子 promote / 幂等 / 复用 /
 * 半复制不算成功 / 不碰 data dir / 失败 Fail Safe。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  PG_BROKEN_PREFIX,
  PG_REQUIRED_BINARIES,
  PG_REQUIRED_LIB_DIR,
  PG_REQUIRED_LIB_DLL,
  PG_REQUIRED_RESOURCES,
  PG_RUNTIME_MARKER,
  PG_STAGING_PREFIX,
  detectBundledPgVersion,
  ensurePgRuntime,
  isAsciiSafePath,
  parsePgVersion,
  readMarker,
  verifyRuntimeComplete,
  writeMarker,
} from "../pgRuntime";

const tmpRoots: string[] = [];

function tmp(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stayops-pgruntime-${label}-`));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** 构造一个「结构完整」的 fake bundled runtime（真实文件 + 可选 build 期 marker）。 */
function makePgSource(
  root: string,
  opts: { version?: string | null } = {},
): string {
  const pg = path.join(root, "postgres", "pgsql");
  fs.mkdirSync(path.join(pg, "bin"), { recursive: true });
  fs.mkdirSync(path.join(pg, "lib"), { recursive: true });
  fs.mkdirSync(path.join(pg, "share", "timezone"), { recursive: true });
  for (const exe of PG_REQUIRED_BINARIES) {
    fs.writeFileSync(path.join(pg, "bin", exe), `stub:${exe}`);
  }
  fs.writeFileSync(path.join(pg, "lib", "libpq.dll"), "stub:libpq");
  for (const rel of PG_REQUIRED_RESOURCES) {
    if (rel.endsWith("timezone")) {
      fs.writeFileSync(path.join(pg, rel, "UTC"), "stub:tz");
    } else {
      fs.writeFileSync(path.join(pg, rel), `stub:${rel}`);
    }
  }
  const version = opts.version === undefined ? "16.15" : opts.version;
  if (version !== null) {
    writeMarker(pg, { version, files: 10, bytes: 100 });
  }
  return pg;
}

function packagedOptions(source: string, root: string) {
  return {
    mode: "packaged" as const,
    bundledPgDir: source,
    devBinDir: path.join(source, "bin"),
    runtimeRootDir: path.join(root, "runtime", "postgresql"),
    pid: 4242,
    randomSuffix: () => "test",
    probeVersion: () => null,
  };
}

describe("pgRuntime · lib/ 完整性（alpha.9.6 QA-9.6-H1）", () => {
  /**
   * 关键 DLL 取自真实 bundled runtime（EDB PG 16.15：`lib/` 145 文件 / 120 DLL，
   * `libpq.dll` 位于 lib/；libcrypto/libssl 在 bin/，不作为 lib 校验项）。
   * 新增用例覆盖 QA 原始复现：materialized runtime 的 lib/ 被删除/清空后
   * 不得判为 reusable。
   */
  it("A. 完整 runtime（lib 存在且含关键 DLL）→ reusable", () => {
    const root = tmp("lib-ok");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);
    const first = ensurePgRuntime(options);
    expect(first.ok && first.action).toBe("materialized");
    if (!first.ok) return;
    const target = path.dirname(first.binDir);
    expect(verifyRuntimeComplete(target, "16.15").ok).toBe(true);
    expect(fs.existsSync(path.join(target, "lib", PG_REQUIRED_LIB_DLL))).toBe(true);
    const second = ensurePgRuntime(options);
    expect(second.ok && second.action).toBe("reused");
  });

  it("B. lib 目录缺失 → NOT reusable → 重新 materialize 并恢复 lib", () => {
    const root = tmp("lib-missing");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);
    const first = ensurePgRuntime(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const target = path.dirname(first.binDir);

    fs.rmSync(path.join(target, "lib"), { recursive: true, force: true });
    const verdict = verifyRuntimeComplete(target, "16.15");
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain(PG_REQUIRED_LIB_DIR);

    const second = ensurePgRuntime(options);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).not.toBe("reused");
    expect(second.action).toBe("materialized");
    expect(fs.existsSync(path.join(target, "lib", PG_REQUIRED_LIB_DLL))).toBe(true);
    expect(verifyRuntimeComplete(target, "16.15").ok).toBe(true);
  });

  it("C. lib 目录为空（存在但无文件）→ NOT reusable", () => {
    const root = tmp("lib-empty");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);
    const first = ensurePgRuntime(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const target = path.dirname(first.binDir);
    const libDir = path.join(target, "lib");
    fs.rmSync(libDir, { recursive: true, force: true });
    fs.mkdirSync(libDir, { recursive: true });

    const verdict = verifyRuntimeComplete(target, "16.15");
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain(PG_REQUIRED_LIB_DIR);

    const second = ensurePgRuntime(options);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe("materialized");
    expect(verifyRuntimeComplete(target, "16.15").ok).toBe(true);
  });

  it("D. lib 非空但缺关键 DLL（libpq.dll）→ NOT reusable", () => {
    const root = tmp("lib-nodll");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);
    const first = ensurePgRuntime(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const target = path.dirname(first.binDir);
    const libDir = path.join(target, "lib");
    fs.rmSync(path.join(libDir, PG_REQUIRED_LIB_DLL), { force: true });
    fs.writeFileSync(path.join(libDir, "some_extension.dll"), "stub:other");

    const verdict = verifyRuntimeComplete(target, "16.15");
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain(path.join(PG_REQUIRED_LIB_DIR, PG_REQUIRED_LIB_DLL));

    const second = ensurePgRuntime(options);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe("materialized");
    expect(fs.existsSync(path.join(libDir, PG_REQUIRED_LIB_DLL))).toBe(true);
  });

  it("E. 损坏 target + 健康 bundled source → 重新 materialize → PASS", () => {
    const root = tmp("lib-repair");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);
    const first = ensurePgRuntime(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const target = path.dirname(first.binDir);
    fs.rmSync(path.join(target, "lib"), { recursive: true, force: true });
    fs.rmSync(path.join(target, "share"), { recursive: true, force: true });

    const second = ensurePgRuntime(options);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe("materialized");
    expect(verifyRuntimeComplete(target, "16.15").ok).toBe(true);
  });

  it("F. 损坏 target + 损坏 bundled source（source 缺 lib）→ Fail Safe（不返回 binDir）", () => {
    const root = tmp("lib-failsafe");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);
    const first = ensurePgRuntime(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const target = path.dirname(first.binDir);
    fs.rmSync(path.join(target, "lib"), { recursive: true, force: true });
    fs.rmSync(path.join(source, "lib"), { recursive: true, force: true });

    const second = ensurePgRuntime(options);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect("binDir" in second).toBe(false);
    expect(second.error).toContain("不完整");
    expect(verifyRuntimeComplete(target, "16.15").ok).toBe(false);
  });

  it("QA 原始复现：删除 materialized runtime 的 lib/ → verify false 且 action != reused", () => {
    const root = tmp("qa-repro");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);
    const first = ensurePgRuntime(options);
    expect(first.ok && first.action).toBe("materialized");
    if (!first.ok) return;
    const target = path.dirname(first.binDir);

    fs.rmSync(path.join(target, "lib"), { recursive: true, force: true });
    expect(verifyRuntimeComplete(target, "16.15").ok).toBe(false);
    const second = ensurePgRuntime(options);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).not.toBe("reused");
    expect(verifyRuntimeComplete(target, "16.15").ok).toBe(true);
  });
});

describe("pgRuntime · development 模式", () => {
  it("直接返回工作区 bin，不创建任何 materialized runtime", () => {
    const root = tmp("dev");
    const source = makePgSource(root);
    const runtimeRoot = path.join(root, "runtime", "postgresql");

    const result = ensurePgRuntime({
      mode: "development",
      bundledPgDir: source,
      devBinDir: path.join(source, "bin"),
      runtimeRootDir: runtimeRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("development");
    expect(result.binDir).toBe(path.join(source, "bin"));
    expect(result.materialized).toBe(false);
    expect(fs.existsSync(runtimeRoot)).toBe(false);
  });
});

describe("pgRuntime · packaged materialization", () => {
  it("materialize 到 ASCII-safe 的版本化路径，并写入完整性标记", () => {
    const root = tmp("materialize");
    const source = makePgSource(root);

    const result = ensurePgRuntime(packagedOptions(source, root));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("materialized");
    expect(result.version).toBe("16.15");
    expect(result.binDir).toBe(
      path.join(root, "runtime", "postgresql", "16.15", "pgsql", "bin"),
    );
    expect(isAsciiSafePath(result.binDir)).toBe(true);

    const runtimeDir = path.dirname(result.binDir);
    for (const exe of PG_REQUIRED_BINARIES) {
      expect(fs.existsSync(path.join(runtimeDir, "bin", exe))).toBe(true);
    }
    const marker = readMarker(runtimeDir);
    expect(marker?.version).toBe("16.15");
    expect(typeof marker?.materializedAt).toBe("string");
    expect(verifyRuntimeComplete(runtimeDir, "16.15").ok).toBe(true);

    // staging / broken 目录不残留
    const versionDir = path.dirname(runtimeDir);
    const leftovers = fs
      .readdirSync(versionDir)
      .filter(
        (entry) =>
          entry.startsWith(PG_STAGING_PREFIX) || entry.startsWith(PG_BROKEN_PREFIX),
      );
    expect(leftovers).toEqual([]);
  });

  it("幂等 + 复用：第二次调用不再复制（保留 target 内的现有文件）", () => {
    const root = tmp("reuse");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);

    const first = ensurePgRuntime(options);
    expect(first.ok && first.action).toBe("materialized");
    if (!first.ok) return;

    // 在 target 内放一个哨兵：若发生重新复制，它会被覆盖
    const sentinel = path.join(path.dirname(first.binDir), "sentinel.txt");
    fs.writeFileSync(sentinel, "keep-me");

    const second = ensurePgRuntime(options);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe("reused");
    expect(second.binDir).toBe(first.binDir);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep-me");
  });

  it("半复制状态（无标记 / 关键文件缺失）绝不被当成成功 runtime", () => {
    const root = tmp("partial");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);
    const target = path.join(options.runtimeRootDir, "16.15", "pgsql");
    fs.mkdirSync(path.join(target, "bin"), { recursive: true });
    fs.writeFileSync(path.join(target, "bin", "postgres.exe"), "half-copied");

    expect(verifyRuntimeComplete(target, "16.15").ok).toBe(false);

    const result = ensurePgRuntime(options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("materialized");
    expect(readMarker(target)?.version).toBe("16.15");
    expect(verifyRuntimeComplete(target, "16.15").ok).toBe(true);
  });

  it("标记存在但 bin 不完整（损坏 runtime）→ 重新 materialize 且隔离旧目录", () => {
    const root = tmp("corrupt");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);
    const target = path.join(options.runtimeRootDir, "16.15", "pgsql");
    fs.mkdirSync(path.join(target, "bin"), { recursive: true });
    writeMarker(target, { version: "16.15" });
    fs.writeFileSync(path.join(target, "bin", "postgres.exe"), "corrupt");

    const result = ensurePgRuntime(options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("materialized");
    expect(verifyRuntimeComplete(target, "16.15").ok).toBe(true);
    const versionDir = path.dirname(target);
    expect(
      fs.readdirSync(versionDir).filter((e) => e.startsWith(PG_BROKEN_PREFIX)),
    ).toEqual([]);
  });

  it("清理崩溃残留的 staging 目录", () => {
    const root = tmp("staging");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);
    const stale = path.join(
      options.runtimeRootDir,
      "16.15",
      `${PG_STAGING_PREFIX}1-dead`,
      "pgsql",
      "bin",
    );
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "postgres.exe"), "stale");

    const result = ensurePgRuntime(options);
    expect(result.ok).toBe(true);
    const versionDir = path.join(options.runtimeRootDir, "16.15");
    expect(
      fs.readdirSync(versionDir).filter((e) => e.startsWith(PG_STAGING_PREFIX)),
    ).toEqual([]);
  });

  it("不触碰 PostgreSQL data 目录 / 不删除已有数据库文件", () => {
    const root = tmp("datadir");
    const source = makePgSource(root);
    const options = packagedOptions(source, root);
    // 模拟 %PROGRAMDATA%\StayOps 布局：runtime/ 与 PostgreSQL/data/ 平级
    const dataDir = path.join(root, "PostgreSQL", "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "PG_VERSION"), "16\n");
    fs.writeFileSync(path.join(dataDir, "postgresql.conf"), "# keep\n");

    const result = ensurePgRuntime(options);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, "PG_VERSION"), "utf8")).toBe("16\n");
    expect(fs.existsSync(path.join(dataDir, "postgresql.conf"))).toBe(true);
  });
});

describe("pgRuntime · Fail Safe", () => {
  it("bundled runtime 缺失 → 报错且不创建 target", () => {
    const root = tmp("missing");
    const options = packagedOptions(path.join(root, "postgres", "pgsql"), root);

    const result = ensurePgRuntime(options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("安装不完整");
    expect(fs.existsSync(options.runtimeRootDir)).toBe(false);
  });

  it("无法识别版本（无 marker 且 binary 探测失败）→ 报错且不创建 target", () => {
    const root = tmp("noversion");
    const source = makePgSource(root, { version: null });
    const options = packagedOptions(source, root);

    const result = ensurePgRuntime(options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("版本");
    expect(fs.existsSync(path.join(options.runtimeRootDir, "16.15"))).toBe(false);
  });

  it("materialize 目标含非 ASCII 字符 → Fail Safe（绝不静默继续）", () => {
    const root = tmp("nonascii");
    const source = makePgSource(root);
    const runtimeRoot = path.join(root, "安客酒店试用软件", "runtime", "postgresql");

    const result = ensurePgRuntime({
      ...packagedOptions(source, root),
      runtimeRootDir: runtimeRoot,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ASCII");
    expect(fs.existsSync(runtimeRoot)).toBe(false);
  });
});

describe("pgRuntime · 版本探测", () => {
  it("优先使用 build 期 marker（不执行 binary 探测）", () => {
    const root = tmp("markerfirst");
    const source = makePgSource(root, { version: "16.15" });
    const probe = vi.fn(() => "99.99");

    expect(detectBundledPgVersion(source, probe)).toBe("16.15");
    expect(probe).not.toHaveBeenCalled();
  });

  it("无 marker 时回退 postgres.exe --version 探测", () => {
    const root = tmp("probefallback");
    const source = makePgSource(root, { version: null });
    const probe = vi.fn(() => "16.15");

    expect(detectBundledPgVersion(source, probe)).toBe("16.15");
    expect(probe).toHaveBeenCalledWith(
      path.join(source, "bin", "postgres.exe"),
    );
  });

  it("parsePgVersion 解析真实版本输出，非法输入返回 null", () => {
    expect(parsePgVersion("postgres (PostgreSQL) 16.15")).toBe("16.15");
    expect(parsePgVersion("postgres (PostgreSQL) 16.4.1")).toBe("16.4.1");
    expect(parsePgVersion("postgres (PostgreSQL) 16")).toBeNull();
    expect(parsePgVersion("not a version")).toBeNull();
  });

  it("isAsciiSafePath 仅接受可打印 ASCII", () => {
    expect(isAsciiSafePath("C:\\ProgramData\\StayOps\\runtime")).toBe(true);
    expect(isAsciiSafePath("D:\\安客酒店试用软件\\StayOps")).toBe(false);
    expect(isAsciiSafePath("C:\\ProgramData\\StayOps\\换")).toBe(false);
    expect(isAsciiSafePath("")).toBe(false);
  });
});

describe("pgRuntime · PG 工具覆盖", () => {
  it("产品使用的 PG CLI 全部来自同一个 ASCII-safe runtime 目录", () => {
    // 产品面：initdb / pg_ctl / pg_isready / psql（运行期）+ pg_dump / pg_restore（备份恢复）
    for (const required of [
      "initdb.exe",
      "pg_ctl.exe",
      "pg_isready.exe",
      "psql.exe",
      "pg_dump.exe",
      "pg_restore.exe",
      "postgres.exe",
    ]) {
      expect(PG_REQUIRED_BINARIES).toContain(required);
    }

    const root = tmp("tools");
    const source = makePgSource(root);
    const result = ensurePgRuntime(packagedOptions(source, root));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const exe of PG_REQUIRED_BINARIES) {
      expect(path.dirname(path.join(result.binDir, exe))).toBe(result.binDir);
      expect(fs.existsSync(path.join(result.binDir, exe))).toBe(true);
    }
    expect(path.basename(result.binDir)).toBe("bin");
    expect(path.basename(path.dirname(result.binDir))).toBe("pgsql");
    expect(path.basename(path.dirname(path.dirname(result.binDir)))).toBe("16.15");
  });

  it("runtime marker 文件不携带任何开发机绝对路径", () => {
    const root = tmp("markerhygiene");
    const source = makePgSource(root);
    const result = ensurePgRuntime(packagedOptions(source, root));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = fs.readFileSync(
      path.join(path.dirname(result.binDir), PG_RUNTIME_MARKER),
      "utf8",
    );
    expect(raw).not.toMatch(/MY SELF|Crowtyard|C:\\Users/i);
    expect(raw).toContain("16.15");
  });
});
