# -*- coding: utf-8 -*-
"""StayOps Desktop Runtime Probe（Electron 桌面壳的 Python 侧检查 CLI）。

Electron 主进程（desktop/src/）不直接查询 PostgreSQL、不解析 Alembic：
所有 DB / Migration / 端口检查统一由本脚本经 backend/.venv 已验证的
Python Runtime 执行（cwd = backend，与 dev_runtime.py 的 alembic 约定一致），
stdout 输出单行 JSON 供 Electron 解析，诊断日志走 stderr（由 Electron
捕获写入 %LOCALAPPDATA%/StayOps/logs/desktop.log 并 scrub）。

仅使用 Python 标准库 + 项目既有依赖（sqlalchemy / app.config），并复用
scripts/dev_runtime.py 中已经过验证的通用逻辑（端口探测 / alembic 封装 /
revision 解析），不新增第三方依赖。

命令：
    ports-check --backend-port 8100 --frontend-port 3100
    db-check
    migration-status
    migration-upgrade
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Windows 控制台默认 GBK：强制 UTF-8 输出避免中文乱码（与 dev_runtime 同策略）
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
_SCRIPTS_DIR = Path(__file__).resolve().parent

# cwd 无关性：任何调用方式下都从 backend 目录加载配置与包
os.chdir(BACKEND_DIR)
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(_SCRIPTS_DIR))

import dev_runtime as dr  # noqa: E402  复用已验证的端口/alembic/revision 逻辑


# ---------------------------------------------------------------------------
# Secret scrub（防御性：任何回传 Electron 的 detail 都不含 DATABASE_URL 密码）
# ---------------------------------------------------------------------------

def scrub_text(text: str) -> str:
    """去掉连接串密码 / sk-* Key 等敏感片段（与 desktop 侧 scrub 互补）。"""
    out = text
    out = __import__("re").sub(
        r"(postgres(?:ql)?\+?[a-z]*://[^:\s/@]+:)[^@\s/]+(@)",
        r"\1****\2",
        out,
    )
    out = __import__("re").sub(r"(sk-[A-Za-z0-9_\-]{4})[A-Za-z0-9_\-]+", r"\1****", out)
    return out


# ---------------------------------------------------------------------------
# db-check
# ---------------------------------------------------------------------------

def _friendly_db_error(exc: Exception, url: str) -> str:
    """把连接异常映射为人类可读文案；绝不回显连接串（含密码）。"""
    from sqlalchemy.engine.url import make_url

    host, port, db = "localhost", "5432", "?"
    try:
        parsed = make_url(url)
        host = parsed.host or "localhost"
        port = str(parsed.port or 5432)
        db = parsed.database or "?"
    except Exception:
        pass
    message = str(exc).lower()
    if "connection refused" in message or "10061" in message:
        return (
            f"PostgreSQL 连接被拒绝（{host}:{port}）：请确认 PostgreSQL 服务"
            f"已启动并监听该端口。"
        )
    if "password authentication failed" in message:
        return f"PostgreSQL 认证失败（用户 {parsed.username or '?'}）：请检查 DATABASE_URL 的用户名/密码。"
    if "database \"" in message and "does not exist" in message:
        return f"PostgreSQL 数据库 {db} 不存在：请检查 DATABASE_URL 的数据库名。"
    if "timeout" in message or "timed out" in message:
        return f"PostgreSQL 连接超时（{host}:{port}）。"
    return f"PostgreSQL 不可用（{exc.__class__.__name__}）：{message[:200]}"


def cmd_db_check() -> dict:
    try:
        from app.config import settings
    except Exception as exc:  # 配置/导入失败同样要可读
        return {
            "ok": False,
            "error": f"后端配置加载失败（{exc.__class__.__name__}）："
            f"请检查 backend/.env 与仓库根 .env。",
        }
    url = settings.database_url
    try:
        from sqlalchemy import create_engine, text

        engine = create_engine(
            url,
            pool_pre_ping=False,
            connect_args={"connect_timeout": 5},
        )
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        engine.dispose()
        return {"ok": True, "error": None}
    except Exception as exc:  # noqa: BLE001  连接失败是预期分支
        return {"ok": False, "error": _friendly_db_error(exc, url)}


# ---------------------------------------------------------------------------
# migration-status / migration-upgrade
# ---------------------------------------------------------------------------

def _parse_heads(output: str) -> list[str]:
    """alembic heads 输出 -> 全部 12 位 revision（多 head 场景全部保留）。"""
    heads: list[str] = []
    for line in output.splitlines():
        token = line.strip().split()
        if token and len(token[0]) == 12 and token[0].isalnum():
            heads.append(token[0])
    return heads


def _parse_current(output: str) -> str | None:
    """alembic current 输出 -> 最后一个 12 位 revision（与 dev_runtime 同解析）。"""
    for line in reversed(output.splitlines()):
        token = line.strip().split()
        if token and len(token[0]) == 12 and token[0].isalnum():
            return token[0]
    return None


def cmd_migration_status() -> dict:
    ok_current, out_current = dr._alembic(["current"])
    ok_heads, out_heads = dr._alembic(["heads"])
    if not (ok_current and ok_heads):
        detail = scrub_text((out_current + out_heads).strip())
        return {
            "state": "ERROR",
            "current": None,
            "heads": [],
            "detail": f"无法读取 Alembic 状态：{detail[-400:]}",
        }
    current = _parse_current(out_current)
    heads = _parse_heads(out_heads)
    if current is None or not heads:
        return {
            "state": "ERROR",
            "current": current,
            "heads": heads,
            "detail": "无法解析 alembic current/heads 输出",
        }
    unique = list(dict.fromkeys(heads))
    if len(unique) > 1:
        return {
            "state": "MULTI_HEAD",
            "current": current,
            "heads": unique,
            "detail": "数据库存在多个 migration head，禁止自动升级（Fail Safe）",
        }
    if current != unique[0]:
        return {
            "state": "BEHIND",
            "current": current,
            "heads": unique,
            "detail": "数据库 schema 落后，需要升级",
        }
    return {"state": "OK", "current": current, "heads": unique, "detail": None}


def cmd_migration_upgrade() -> dict:
    ok, out = dr.migration_upgrade()
    if ok:
        return {"ok": True, "detail": "alembic upgrade head 成功"}
    return {"ok": False, "detail": scrub_text(out.strip())[-400:]}


# ---------------------------------------------------------------------------
# ports-check
# ---------------------------------------------------------------------------

def cmd_ports_check(args: argparse.Namespace) -> dict:
    occupied: list[dict] = []
    for label, port in (
        ("backend", args.backend_port),
        ("frontend", args.frontend_port),
    ):
        if dr.port_in_use("127.0.0.1", port):
            occupied.append({"label": label, "port": port, "pid": dr.pid_for_port(port)})
    return {"ok": len(occupied) == 0, "occupied": occupied}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="StayOps Desktop Runtime Probe")
    sub = parser.add_subparsers(dest="command", required=True)

    p_ports = sub.add_parser("ports-check", help="检查桌面端口是否被占用")
    p_ports.add_argument("--backend-port", type=int, default=8100)
    p_ports.add_argument("--frontend-port", type=int, default=3100)

    sub.add_parser("db-check", help="测试 PostgreSQL 连接")
    sub.add_parser("migration-status", help="读取 alembic current/heads 状态")
    sub.add_parser("migration-upgrade", help="执行 alembic upgrade head")
    args = parser.parse_args()

    if args.command == "ports-check":
        result = cmd_ports_check(args)
    elif args.command == "db-check":
        result = cmd_db_check()
    elif args.command == "migration-status":
        result = cmd_migration_status()
    elif args.command == "migration-upgrade":
        result = cmd_migration_upgrade()
    else:
        parser.error(f"未知命令: {args.command}")

    print(json.dumps(result, ensure_ascii=False), flush=True)
    ok = result.get("ok", result.get("state") in ("OK", "BEHIND", "MULTI_HEAD"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
