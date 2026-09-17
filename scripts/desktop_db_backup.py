# -*- coding: utf-8 -*-
"""StayOps 自带 PostgreSQL 备份 / 恢复工具（纯 stdlib + PG runtime 工具）。

备份（默认）：
    python scripts/desktop_db_backup.py
    输出：%PROGRAMDATA%\\StayOps\\backups\\stayops-YYYYMMDD-HHMMSS.dump（pg_dump -Fc）
          + 同名 .sha256 校验文件

恢复（显式确认，--restore <dump> --yes）：
    将指定 dump 恢复到 StayOps 自带实例（127.0.0.1:5433）的 stayops 库。
    恢复会先 --clean 重建对象；不会删除实例或其它数据库。

说明：
    - 凭据来自 %PROGRAMDATA%\\StayOps\\PostgreSQL\\conf\\dbpass.conf（不回显）。
    - 备份/恢复仅针对自带实例，与开发 Docker（5432）互不影响。
    - **PG 工具路径与 Desktop 主进程使用同一个 resolver**（alpha.9.6 Windows
      hotfix）：安装版优先使用 `%PROGRAMDATA%\\StayOps\\runtime\\postgresql\\
      <version>\\pgsql\\bin`（ASCII-safe materialized runtime），保证「initdb 用
      ASCII runtime、pg_dump 却仍从含中文的 resourcesPath 运行」这类不一致不会出现。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import locale
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[1]

# 与 desktop/src/runtime/pgRuntime.ts 保持一致（同一 resolver 语义）
PG_RUNTIME_MARKER = ".stayops-runtime.json"
PROGRAM_DATA = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData"))
PG_RUNTIME_ROOT = PROGRAM_DATA / "StayOps" / "runtime" / "postgresql"


def _materialized_pg_bin() -> tuple[Path | None, str | None]:
    """选择安装在 ASCII-safe 路径下的 materialized runtime（含完整性标记与 pg_dump）。"""
    if not PG_RUNTIME_ROOT.is_dir():
        return None, None
    candidates: list[tuple[tuple[int, ...], Path, str]] = []
    for version_dir in PG_RUNTIME_ROOT.iterdir():
        if not version_dir.is_dir() or version_dir.name.startswith("."):
            continue
        pg_dir = version_dir / "pgsql"
        marker = pg_dir / PG_RUNTIME_MARKER
        if not marker.is_file() or not (pg_dir / "bin" / "pg_dump.exe").is_file():
            continue  # 半复制 / 缺标记 → 绝不当成可用 runtime
        version = version_dir.name
        try:
            parsed = json.loads(marker.read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError):
            parsed = None
        key = tuple(int(part) for part in version.split(".") if part.isdigit()) or (0,)
        candidates.append((key, pg_dir / "bin", str(parsed or version)))
    if not candidates:
        return None, None
    candidates.sort(key=lambda item: item[0], reverse=True)
    _, bin_dir, version = candidates[0]
    return bin_dir, version


def resolve_pg_bin(explicit: str | None) -> tuple[Path, str]:
    """统一 runtime resolver：返回 (bin 目录, 来源说明)。

    1. `--pg-bin` 显式指定（测试 / 高级用法）
    2. Packaged Mode（<安装目录>/postgres/pgsql/bin 存在）：
       2a. materialized ASCII-safe runtime（%PROGRAMDATA%，优先最高版本）
       2b. 回退 bundled resources/postgres/pgsql/bin（安装路径为 ASCII 时等价可用）
    3. Development Mode：<workspace>/runtime/postgres/pgsql/bin（行为不变）
    """
    if explicit:
        return Path(explicit), "explicit --pg-bin"
    bundled = WORKSPACE / "postgres" / "pgsql" / "bin"
    if bundled.is_dir():
        materialized, version = _materialized_pg_bin()
        if materialized is not None:
            return materialized, f"materialized ASCII-safe runtime (pg {version})"
        return bundled, "bundled resources/postgres（未找到 materialized runtime）"
    return WORKSPACE / "runtime" / "postgres" / "pgsql" / "bin", "development workspace runtime"


def _preferred_decodings() -> tuple[str, ...]:
    encodings: list[str] = []
    try:
        pref = locale.getpreferredencoding(False)
        if pref:
            encodings.append(pref)
    except Exception:
        pass
    for name in ("mbcs", "cp936", "cp1252"):
        if name not in encodings:
            encodings.append(name)
    return tuple(encodings)


def decode_pg_output(raw: bytes | None) -> str:
    """稳健解码 PG CLI 输出：UTF-8 → 系统 preferred encoding/mbcs → replacement。

    只处理 CLI 文本解码，不改变数据库编码（中文 Windows 下 PG 可能按 ANSI
    codepage 输出，例如 `FATAL: ... "UTF8": 0xb0` 附近的路径文本）。
    """
    if not raw:
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    for encoding in _preferred_decodings():
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


DEFAULT_CREDS = PROGRAM_DATA / "StayOps" / "PostgreSQL" / "conf" / "dbpass.conf"
BACKUP_DIR = PROGRAM_DATA / "StayOps" / "backups"
HOST, PORT, USER, DB = "127.0.0.1", "5433", "stayops", "stayops"

_NO_WINDOW = {"creationflags": 0x08000000} if os.name == "nt" else {}


def _run(args: list[str], timeout: int = 600, env: dict | None = None) -> tuple[int, str, str]:
    proc = subprocess.run(
        args, capture_output=True,
        timeout=timeout, env=env, stdin=subprocess.DEVNULL, **_NO_WINDOW,
    )
    return (
        proc.returncode,
        decode_pg_output(proc.stdout),
        decode_pg_output(proc.stderr),
    )


def _pg_env() -> dict:
    password = DEFAULT_CREDS.read_text(encoding="utf-8").strip().splitlines()[0]
    return dict(os.environ, PGPASSWORD=password)


def cmd_backup(pg_bin: Path) -> int:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dump = BACKUP_DIR / f"stayops-{stamp}.dump"
    env = _pg_env()
    with open(dump, "wb") as fh:
        proc = subprocess.run(
            [str(pg_bin / "pg_dump.exe"), "-h", HOST, "-p", PORT, "-U", USER, "-d", DB, "-Fc"],
            stdout=fh, stderr=subprocess.PIPE, env=env, stdin=subprocess.DEVNULL, **_NO_WINDOW,
        )
    if proc.returncode != 0:
        print("备份失败：", decode_pg_output(proc.stderr)[-300:], file=sys.stderr)
        return 1
    sha = hashlib.sha256(dump.read_bytes()).hexdigest().upper()
    (BACKUP_DIR / f"{dump.name}.sha256").write_text(sha + "\n", encoding="utf-8")
    print(f"备份完成：{dump} ({dump.stat().st_size} bytes)")
    print(f"SHA256: {sha}")
    print(f"恢复命令：python scripts/desktop_db_backup.py --restore {dump} --yes")
    return 0


def cmd_restore(pg_bin: Path, dump: Path) -> int:
    if not dump.exists():
        print(f"备份文件不存在：{dump}", file=sys.stderr)
        return 1
    print(f"即将恢复 {dump} 到 {HOST}:{PORT}/{DB}（--clean 重建对象）…")
    code, _, err = _run(
        [str(pg_bin / "pg_restore.exe"), "-h", HOST, "-p", PORT, "-U", USER, "-d", DB,
         "--clean", "--if-exists", "--exit-on-error", str(dump)],
        env=_pg_env(),
    )
    if code != 0:
        print("恢复失败：", err[-500:], file=sys.stderr)
        return 1
    print("恢复完成。请重新启动 StayOps 以验证。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="StayOps PostgreSQL 备份/恢复")
    parser.add_argument(
        "--pg-bin",
        default=None,
        help="显式指定 PostgreSQL bin 目录（默认走统一 resolver：materialized ASCII-safe runtime → bundled → 开发工作区）",
    )
    parser.add_argument("--restore", help="要恢复的 .dump 文件")
    parser.add_argument("--yes", action="store_true", help="确认执行恢复（破坏性）")
    args = parser.parse_args()

    pg_bin, source = resolve_pg_bin(args.pg_bin)
    if not (pg_bin / "pg_dump.exe").exists():
        print(f"未找到 PostgreSQL 运行时：{pg_bin}（来源：{source}）", file=sys.stderr)
        return 1
    print(f"PostgreSQL runtime：{pg_bin}（{source}）")
    if args.restore:
        if not args.yes:
            print("恢复是破坏性操作：请加 --yes 确认", file=sys.stderr)
            return 1
        return cmd_restore(pg_bin, Path(args.restore))
    return cmd_backup(pg_bin)


if __name__ == "__main__":
    sys.exit(main())
