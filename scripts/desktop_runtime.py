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
# db-ensure（StayOps 自带 PostgreSQL Runtime：init / start / ready / 建库）
#
# 架构（docs/DECISIONS.md · StayOps 自带 PostgreSQL Runtime）：
#   - PostgreSQL 16 Windows binaries 随 runtime 分发（<workspace>/runtime/postgres/pgsql）
#   - 数据目录独立于程序目录：%PROGRAMDATA%\StayOps\PostgreSQL\data（升级不触碰）
#   - 首次运行 initdb（自动生成 scram 密码并写凭据文件，icacls 收紧 ACL）
#   - 后续运行 pg_ctl start（进程与 StayOps 解耦，退出后保持运行，异常由 WAL 恢复）
#   - 仅监听 127.0.0.1:5433；成功返回 dbUrl（含密码，仅经进程管道传给 Electron）
# ---------------------------------------------------------------------------

STAYOPS_PG_SUPERUSER = "stayops"
STAYOPS_PG_DATABASE = "stayops"

# postgresql.conf 追加段（幂等：以 # stayops-auto 标记识别）
_STAYOPS_PG_CONF = """\
# stayops-auto
port = {port}
listen_addresses = '127.0.0.1'
"""


def _no_window_kwargs() -> dict:
    """子进程无控制台弹窗（Electron 调用链上无继承控制台）。"""
    kwargs: dict = {}
    if os.name == "nt":
        try:
            kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        except Exception:
            pass
    return kwargs


def _pg_run(bin_path: Path, args: list[str], timeout: int, env: dict | None = None) -> tuple[int, str, str]:
    """运行 PG 工具，返回 (exit_code, stdout, stderr)；永抛异常不外泄。"""
    proc = __import__("subprocess").run(
        [str(bin_path), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=env,
        **_no_window_kwargs(),
    )
    return proc.returncode, proc.stdout, proc.stderr


def _pg_run(bin_path: Path, args: list[str], timeout: int, env: dict | None = None) -> tuple[int, str, str]:
    """运行 PG 工具，返回 (exit_code, stdout, stderr)；stdin 关闭避免任何交互挂起。"""
    proc = __import__("subprocess").run(
        [str(bin_path), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=env,
        stdin=__import__("subprocess").DEVNULL,
        **_no_window_kwargs(),
    )
    return proc.returncode, proc.stdout, proc.stderr


def _read_password(creds_file: Path) -> str | None:
    try:
        text = creds_file.read_text(encoding="utf-8")
        line = next((ln.strip() for ln in text.splitlines() if ln.strip()), None)
        return line or None
    except OSError:
        return None


def _tighten_acl(path: Path) -> None:
    """收紧 ACL：仅当前用户 + SYSTEM + Administrators 可读（icacls 语法：:R 无括号）。"""
    user = __import__("getpass").getuser()
    sub = __import__("subprocess")
    try:
        sub.run(["icacls", str(path), "/inheritance:r"], capture_output=True, timeout=15, **_no_window_kwargs())
        for grant in (f"{user}:R", "SYSTEM:R", "Administrators:R"):
            sub.run(["icacls", str(path), "/grant:r", grant], capture_output=True, timeout=15, **_no_window_kwargs())
    except Exception:
        pass  # ACL 收紧失败不阻断启动（文件仍在用户私有目录）


def _ensure_creds(creds_file: Path) -> str:
    """凭据文件不存在则生成随机密码并收紧 ACL；返回密码。"""
    existing = _read_password(creds_file)
    if existing:
        return existing
    creds_file.parent.mkdir(parents=True, exist_ok=True)
    password = __import__("secrets").token_urlsafe(24)
    creds_file.write_text(password + "\n", encoding="utf-8")
    if os.name == "nt":
        _tighten_acl(creds_file)
    # 可读性校验：ACL 异常导致不可读时回退（/reset 后仅授当前用户）
    if _read_password(creds_file) != password:
        try:
            creds_file.write_text(password + "\n", encoding="utf-8")
            __import__("subprocess").run(["icacls", str(creds_file), "/reset"], capture_output=True, timeout=15, **_no_window_kwargs())
            __import__("subprocess").run(
                ["icacls", str(creds_file), "/inheritance:r", "/grant:r", f"{__import__('getpass').getuser()}:R"],
                capture_output=True,
                timeout=15,
                **_no_window_kwargs(),
            )
        except Exception:
            pass
    return password


def _pg_connect_ok(bin_dir: Path, port: int, password: str, dbname: str) -> bool:
    """psql SELECT 1 认证连接检查（127.0.0.1；-w 禁止密码提示，stdin 关闭防挂起）。"""
    env = dict(os.environ)
    env["PGPASSWORD"] = password
    code, out, _ = _pg_run(
        bin_dir / "psql.exe",
        ["-w", "-h", "127.0.0.1", "-p", str(port), "-U", STAYOPS_PG_SUPERUSER, "-d", dbname, "-tAc", "SELECT 1"],
        timeout=10,
        env=env,
    )
    return code == 0 and out.strip() == "1"


def _pg_is_ready(bin_dir: Path, port: int) -> bool:
    code, _, _ = _pg_run(
        bin_dir / "pg_isready.exe",
        ["-h", "127.0.0.1", "-p", str(port), "-q"],
        timeout=5,
    )
    return code == 0


def _apply_conf(data_dir: Path, port: int) -> None:
    """幂等写入 port / listen_addresses 覆盖段。"""
    conf = data_dir / "postgresql.conf"
    text = conf.read_text(encoding="utf-8", errors="replace")
    if "# stayops-auto" in text:
        return
    with conf.open("a", encoding="utf-8") as fh:
        fh.write("\n" + _STAYOPS_PG_CONF.format(port=port))


def _pg_log_tail(data_dir: Path, lines: int = 12) -> str:
    """启动失败时读取最近日志（按修改时间取最新文件）。"""
    log_dir = data_dir / "log"
    try:
        files = sorted(log_dir.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return ""
    if not files:
        return ""
    try:
        return "\n".join(files[0].read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return ""


def _pg_ctl_start(bin_dir: Path, data_dir: Path, port: int) -> tuple[int, str]:
    """pg_ctl start（关键：不能用管道捕获输出——postgres 会继承管道句柄导致
    subprocess 等待 EOF 永久挂起；改为 -l 日志文件 + DEVNULL）。"""
    log_dir = data_dir / "log"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "pg_ctl-start.log"
    proc = __import__("subprocess").run(
        [
            str(bin_dir / "pg_ctl.exe"),
            "start", "-w", "-t", "60",
            "-D", str(data_dir),
            "-l", str(log_file),
            "-s",
            "-o", f"-p {port} -h 127.0.0.1",
        ],
        stdout=__import__("subprocess").DEVNULL,
        stderr=__import__("subprocess").DEVNULL,
        stdin=__import__("subprocess").DEVNULL,
        timeout=90,
        **_no_window_kwargs(),
    )
    return proc.returncode, _pg_log_tail(data_dir)


def cmd_db_ensure(args: argparse.Namespace) -> dict:
    pg_bin = Path(args.pg_bin)
    data_dir = Path(args.data_dir)
    creds_file = Path(args.creds_file)
    port = int(args.port)
    timeout_ms = int(args.timeout_ms)
    deadline = __import__("time").monotonic() + timeout_ms / 1000.0

    missing = [n for n in ("pg_ctl.exe", "initdb.exe", "psql.exe", "pg_isready.exe") if not (pg_bin / n).exists()]
    if missing:
        return {
            "ok": False,
            "initialized": False,
            "dbUrl": None,
            "error": "PostgreSQL 运行时缺失（runtime/postgres/pgsql/bin 不完整："
            + ", ".join(missing)
            + "）。请重新安装 StayOps Desktop。",
        }

    password = _ensure_creds(creds_file)

    def _step(msg: str) -> None:
        print(f"[db-ensure] {msg}", file=sys.stderr, flush=True)

    already_running = (data_dir / "PG_VERSION").exists() and _pg_connect_ok(
        pg_bin, port, password, "postgres"
    )
    initialized = False

    if not already_running:
        # 首次初始化
        if not (data_dir / "PG_VERSION").exists():
            initialized = True
            _step("first run: initdb …")
            pwfile = data_dir.parent / ".stayops-pwfile.tmp"
            try:
                pwfile.write_text(password + "\n", encoding="utf-8")
                data_dir.parent.mkdir(parents=True, exist_ok=True)
                code, _, err = _pg_run(
                    pg_bin / "initdb.exe",
                    [
                        "-D", str(data_dir),
                        "-U", STAYOPS_PG_SUPERUSER,
                        "-A", "scram-sha-256",
                        f"--pwfile={pwfile}",
                        "-E", "UTF8",
                        "--locale=C",
                    ],
                    timeout=180,
                )
            finally:
                try:
                    pwfile.unlink()
                except OSError:
                    pass
            if code != 0:
                _step(f"initdb failed: {scrub_text(err.strip())[-200:]}")
                return {
                    "ok": False,
                    "initialized": True,
                    "dbUrl": None,
                    "error": "数据库初始化失败：" + scrub_text(err.strip())[-400:],
                }
            _apply_conf(data_dir, port)
            _step("initdb done")

        # 启动（已运行则跳过）
        if not _pg_is_ready(pg_bin, port):
            _step("starting postgres …")
            code, tail = _pg_ctl_start(pg_bin, data_dir, port)
            if code != 0:
                tail_scrubbed = scrub_text(tail)
                detail = ("\n日志尾部：\n" + tail_scrubbed if tail_scrubbed else "未知原因")[-500:]
                _step(f"pg_ctl start failed: {detail[-200:]}")
                return {
                    "ok": False,
                    "initialized": initialized,
                    "dbUrl": None,
                    "error": "PostgreSQL 启动失败（仅监听 127.0.0.1:%d）：%s" % (port, detail),
                }
            _step("pg_ctl start ok")

        # 等待就绪（pg_isready + 认证连接）
        while __import__("time").monotonic() < deadline:
            if _pg_is_ready(pg_bin, port) and _pg_connect_ok(pg_bin, port, password, "postgres"):
                break
            __import__("time").sleep(1.0)
        else:
            tail = scrub_text(_pg_log_tail(data_dir))
            return {
                "ok": False,
                "initialized": initialized,
                "dbUrl": None,
                "error": "PostgreSQL 启动超时（127.0.0.1:%d 未就绪）。%s" % (port, "日志尾部：\n" + tail if tail else ""),
            }
        _step("postgres ready and authenticating OK")
    else:
        _step("instance already running and authenticating OK")

    # 确保业务库存在（首次 initdb 后建库；后续幂等跳过——快速路径与冷启动路径共用）
    if not _pg_connect_ok(pg_bin, port, password, STAYOPS_PG_DATABASE):
        _step("creating database stayops …")
        env = dict(os.environ)
        env["PGPASSWORD"] = password
        code, _, err = _pg_run(
            pg_bin / "psql.exe",
            ["-w", "-h", "127.0.0.1", "-p", str(port), "-U", STAYOPS_PG_SUPERUSER, "-d", "postgres", "-c", f"CREATE DATABASE {STAYOPS_PG_DATABASE}"],
            timeout=30,
            env=env,
        )
        if code != 0:
            return {
                "ok": False,
                "initialized": initialized,
                "dbUrl": None,
                "error": "创建业务数据库 stayops 失败：" + scrub_text(err.strip())[-300:],
            }
        _step("database stayops created")

    return {
        "ok": True,
        "initialized": initialized,
        "dbUrl": f"postgresql://{STAYOPS_PG_SUPERUSER}:{password}@127.0.0.1:{port}/{STAYOPS_PG_DATABASE}",
    }


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
    p_ensure = sub.add_parser("db-ensure", help="确保 StayOps 自带 PostgreSQL 实例运行")
    p_ensure.add_argument("--pg-bin", required=True, help="runtime/postgres/pgsql/bin 目录")
    p_ensure.add_argument("--data-dir", required=True, help="PGDATA 数据目录")
    p_ensure.add_argument("--creds-file", required=True, help="密码凭据文件路径")
    p_ensure.add_argument("--port", type=int, default=5433)
    p_ensure.add_argument("--timeout-ms", type=int, default=60000)
    sub.add_parser("migration-status", help="读取 alembic current/heads 状态")
    sub.add_parser("migration-upgrade", help="执行 alembic upgrade head")
    args = parser.parse_args()

    if args.command == "ports-check":
        result = cmd_ports_check(args)
    elif args.command == "db-check":
        result = cmd_db_check()
    elif args.command == "db-ensure":
        result = cmd_db_ensure(args)
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
