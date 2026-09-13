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
"""

from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[1]
DEFAULT_PG_BIN = WORKSPACE / "runtime" / "postgres" / "pgsql" / "bin"
DEFAULT_CREDS = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "StayOps" / "PostgreSQL" / "conf" / "dbpass.conf"
BACKUP_DIR = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "StayOps" / "backups"
HOST, PORT, USER, DB = "127.0.0.1", "5433", "stayops", "stayops"

_NO_WINDOW = {"creationflags": 0x08000000} if os.name == "nt" else {}


def _run(args: list[str], timeout: int = 600, env: dict | None = None) -> tuple[int, str, str]:
    proc = subprocess.run(
        args, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout, env=env, stdin=subprocess.DEVNULL, **_NO_WINDOW,
    )
    return proc.returncode, proc.stdout, proc.stderr


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
        print("备份失败：", proc.stderr.decode("utf-8", "replace")[-300:], file=sys.stderr)
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
    parser.add_argument("--pg-bin", default=str(DEFAULT_PG_BIN), help="runtime/postgres/pgsql/bin 目录")
    parser.add_argument("--restore", help="要恢复的 .dump 文件")
    parser.add_argument("--yes", action="store_true", help="确认执行恢复（破坏性）")
    args = parser.parse_args()

    pg_bin = Path(args.pg_bin)
    if not (pg_bin / "pg_dump.exe").exists():
        print("未找到 PostgreSQL 运行时（runtime/postgres/pgsql/bin）", file=sys.stderr)
        return 1
    if args.restore:
        if not args.yes:
            print("恢复是破坏性操作：请加 --yes 确认", file=sys.stderr)
            return 1
        return cmd_restore(pg_bin, Path(args.restore))
    return cmd_backup(pg_bin)


if __name__ == "__main__":
    sys.exit(main())
