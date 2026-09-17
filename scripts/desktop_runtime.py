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
import locale
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
    if not heads:
        return {
            "state": "ERROR",
            "current": current,
            "heads": heads,
            "detail": "无法解析 alembic heads 输出",
        }
    # 全新安装：空数据库尚未应用任何 revision（alembic current 无输出）
    # → 视为 BEHIND，走既有的「数据库需要升级」确认流程（绝不自动升级）
    if current is None:
        return {
            "state": "BEHIND",
            "current": "(empty)",
            "heads": list(dict.fromkeys(heads)),
            "detail": "全新数据库：尚未应用任何迁移，需要初始化 schema",
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

# 初始化未完成标记（alpha.9.6 Windows hotfix）：
#   initdb 开始前写入，成功后删除。只有「标记存在且 PG_VERSION 不存在」的目录
#   才被认定为**失败初始化的残留**，允许清理重试；有 PG_VERSION 的 cluster
#   永远不允许被自动删除。
#
#   ⚠ 标记文件必须放在 data 目录**之外（同级）**：initdb 要求目标目录为空，
#   任何放在 data 里面的文件都会让 initdb 直接失败
#   （"directory exists but is not empty"，2026-09-17 实机 QA 捕获）。
INIT_INCOMPLETE_MARKER = ".stayops-init-incomplete"

DATA_DIR_ABSENT = "absent"
DATA_DIR_EMPTY = "empty"
DATA_DIR_VALID_CLUSTER = "valid_cluster"
DATA_DIR_PARTIAL_FAILED_INIT = "partial_failed_init"
DATA_DIR_UNKNOWN_NONEMPTY = "unknown_nonempty"


def init_marker_path(data_dir: Path) -> Path:
    """失败初始化标记的位置（data 目录的**同级**文件，绝不放进 data 目录）。

    文件名 = `<data 目录名>` + 后缀，例如
    `%PROGRAMDATA%\\StayOps\\PostgreSQL\\data.stayops-init-incomplete`
    —— 与具体 data 目录一一对应（同一父目录下多个 data 目录也不会互相干扰）。
    """
    return data_dir.parent / f"{data_dir.name}{INIT_INCOMPLETE_MARKER}"


def classify_data_dir(data_dir: Path) -> str:
    """判定数据目录状态（决定是否允许初始化 / 清理重试）。

    - absent / empty                  → 正常首次初始化
    - valid_cluster（有 PG_VERSION）   → **永不清理**，走启动路径
    - partial_failed_init             → 有 incomplete 标记且无 PG_VERSION：可安全重试
    - unknown_nonempty                → 非空、无 PG_VERSION、无标记：拒绝动手（Fail Safe）

    注：历史版本曾把标记写在 data 目录内，这里对残留的 in-dir 标记文件
    做兼容（不算作"内容"，可被清理）。
    """
    try:
        if not data_dir.exists():
            return DATA_DIR_ABSENT
        if (data_dir / "PG_VERSION").is_file():
            return DATA_DIR_VALID_CLUSTER
        entries = [e for e in data_dir.iterdir() if e.name != INIT_INCOMPLETE_MARKER]
    except OSError:
        return DATA_DIR_UNKNOWN_NONEMPTY
    if not entries:
        return DATA_DIR_EMPTY
    if init_marker_path(data_dir).is_file():
        return DATA_DIR_PARTIAL_FAILED_INIT
    return DATA_DIR_UNKNOWN_NONEMPTY


def clean_partial_data_dir(data_dir: Path) -> tuple[bool, str]:
    if (data_dir / "PG_VERSION").exists():
        return False, "存在 PG_VERSION（有效数据库 cluster）——拒绝清理"
    if not init_marker_path(data_dir).is_file():
        return False, f"缺少 {INIT_INCOMPLETE_MARKER} 标记——无法确认是失败初始化残留，拒绝清理"
    removed = 0
    for child in sorted(data_dir.iterdir()):
        try:
            if child.is_dir() and not child.is_symlink():
                __import__("shutil").rmtree(child, ignore_errors=True)
            else:
                child.unlink()
            removed += 1
        except OSError:
            pass
    return True, f"已清理失败初始化残留（{removed} 项，无 PG_VERSION）"

# postgresql.conf 追加段（幂等：以 # stayops-auto 标记识别）
_STAYOPS_PG_CONF = """\
# stayops-auto
port = {port}
listen_addresses = '127.0.0.1'
"""


def _preferred_decodings() -> tuple[str, ...]:
    """解码候选顺序：UTF-8 → Windows preferred encoding / mbcs → 常见 ANSI codepage。"""
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
    """稳健解码 PostgreSQL CLI 输出（**不改变数据库编码**，只处理 CLI 文本）。

    背景（alpha.9.6 Windows hotfix）：中文 Windows 下 PG 工具的部分输出按 ANSI
    codepage 编码（如 GBK），无条件 `encoding="utf-8"` 解码会得到乱码
    （`D:/���;Ƶ��������/…`），既污染用户可见错误，也让真正的原因难以定位。

    顺序（严格按规范，绝不因为解码失败中断启动流程）：
    1. UTF-8 strict —— PG 在 UTF-8 环境下的正常输出
    2. Windows preferred encoding / mbcs（回退 cp936 / cp1252）
    3. UTF-8 replacement —— 最后兜底，永不抛异常
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
    """运行 PG 工具，返回 (exit_code, stdout, stderr)；stdin 关闭避免任何交互挂起。

    输出按 `decode_pg_output` 稳健解码（先 UTF-8，再系统 preferred encoding/mbcs，
    最后 replacement）—— 中文 Windows 下 PG 可能输出 ANSI codepage 文本。
    """
    proc = __import__("subprocess").run(
        [str(bin_path), *args],
        capture_output=True,
        timeout=timeout,
        env=env,
        stdin=__import__("subprocess").DEVNULL,
        **_no_window_kwargs(),
    )
    return (
        proc.returncode,
        decode_pg_output(proc.stdout),
        decode_pg_output(proc.stderr),
    )


def _read_password(creds_file: Path) -> str | None:
    try:
        text = creds_file.read_text(encoding="utf-8")
        line = next((ln.strip() for ln in text.splitlines() if ln.strip()), None)
        return line or None
    except OSError:
        return None


def _current_user_sid() -> str | None:
    """当前用户 SID。

    必须用 whoami.exe（PATH 上的 whoami 可能是 Git/MSYS 的 Unix 版本），
    并且用 SID 而不是账号名授权：`icacls /grant:r <账号名>:R` 会被解释成
    「域 <账号名> + 空账号名」，生成无效 ACE，配合 /inheritance:r
    会把当前用户锁在文件之外（实测缺陷）。
    """
    sub = __import__("subprocess")
    for exe in ("whoami.exe", "whoami"):
        try:
            proc = sub.run(
                [exe, "/user", "/fo", "csv", "/nh"],
                capture_output=True,
                text=True,
                timeout=10,
                **_no_window_kwargs(),
            )
        except Exception:
            continue
        if proc.returncode != 0:
            continue
        for token in proc.stdout.replace('"', "").split(","):
            token = token.strip()
            if token.startswith("S-1-"):
                return token
    return None


def _dir_writable(path: Path) -> bool:
    """目录可写探测（创建并删除临时文件）。"""
    try:
        probe = path / ".stayops-write-probe"
        probe.write_text("1", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def _ensure_dir_writable(path: Path) -> bool:
    """确保目录存在且当前用户可写；不可写时先尝试修复 ACL。

    背景（实测缺陷）：旧版 `_tighten_acl` 用账号名授权，被 icacls 解析为
    「域 + 空账号名」→ 生成无效 ACE（形如 `<用户名>\\:(R)`），配合 /inheritance:r
    会把当前用户锁在 %PROGRAMDATA%\\StayOps\\config 之外（alpha.9.3 安装遗留）。
    因此这里必须能**自愈**：/reset 恢复继承 → 只授当前用户 SID（完全控制）。
    """
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    if _dir_writable(path):
        return True
    sub = __import__("subprocess")
    sid = _current_user_sid()
    try:
        sub.run(["icacls", str(path), "/reset"], capture_output=True, timeout=15, **_no_window_kwargs())
        if sid:
            sub.run(
                ["icacls", str(path), "/inheritance:r", "/grant:r", f"*{sid}:F"],
                capture_output=True,
                timeout=15,
                **_no_window_kwargs(),
            )
    except Exception:
        pass
    return _dir_writable(path)


def _tighten_acl(path: Path) -> None:
    """收紧 ACL：仅当前用户（完全控制）+ SYSTEM(R) + Administrators(R)。

    - 用 SID 授权，避免账号名解析失败生成无效 ACE；
    - 收紧后**读回/写入校验**，失败则回退继承（宁可 ACL 较宽，也不能把自己锁在外面）。
    """
    if os.name != "nt":
        return
    sid = _current_user_sid()
    owner_ace = f"*{sid}:F" if sid else None
    sub = __import__("subprocess")

    def _grant(grants: tuple[str | None, ...]) -> None:
        try:
            sub.run(
                ["icacls", str(path), "/inheritance:r"],
                capture_output=True,
                timeout=15,
                **_no_window_kwargs(),
            )
            for grant in grants:
                if grant:
                    sub.run(
                        ["icacls", str(path), "/grant:r", grant],
                        capture_output=True,
                        timeout=15,
                        **_no_window_kwargs(),
                    )
        except Exception:
            pass

    def _reset_and_grant_owner() -> None:
        try:
            sub.run(
                ["icacls", str(path), "/reset"],
                capture_output=True,
                timeout=15,
                **_no_window_kwargs(),
            )
            if owner_ace:
                sub.run(
                    ["icacls", str(path), "/inheritance:r", "/grant:r", owner_ace],
                    capture_output=True,
                    timeout=15,
                    **_no_window_kwargs(),
                )
        except Exception:
            pass

    def _usable() -> bool:
        try:
            if path.is_file():
                path.read_bytes()
                return True
            return _dir_writable(path)
        except OSError:
            return False

    _grant((owner_ace, "*S-1-5-18:R", "*S-1-5-32-544:R"))
    if not _usable():
        # 收紧把自己锁住：先尝试恢复继承并只授当前用户，仍不可用则保留继承（安全让位于可用）
        _reset_and_grant_owner()
        if not _usable():
            try:
                sub.run(["icacls", str(path), "/reset"], capture_output=True, timeout=15, **_no_window_kwargs())
            except Exception:
                pass


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
    # 可读性校验：ACL 异常导致不可读时回退（/reset 后仅授当前用户 SID）
    if _read_password(creds_file) != password:
        sub = __import__("subprocess")
        sid = _current_user_sid()
        owner_ace = f"*{sid}:F" if sid else None
        try:
            sub.run(["icacls", str(creds_file), "/reset"], capture_output=True, timeout=15, **_no_window_kwargs())
            if owner_ace:
                sub.run(
                    ["icacls", str(creds_file), "/inheritance:r", "/grant:r", owner_ace],
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
    text = decode_pg_output(conf.read_bytes())
    if "# stayops-auto" in text:
        return
    with conf.open("a", encoding="utf-8") as fh:
        fh.write("\n" + _STAYOPS_PG_CONF.format(port=port))


def _pg_log_tail(data_dir: Path, lines: int = 12) -> str:
    """启动失败时读取最近日志（按修改时间取最新文件；稳健解码避免乱码）。"""
    log_dir = data_dir / "log"
    try:
        files = sorted(log_dir.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return ""
    if not files:
        return ""
    try:
        return "\n".join(
            decode_pg_output(files[0].read_bytes()).splitlines()[-lines:]
        )
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


def _pg_ctl_stop(bin_dir: Path, data_dir: Path) -> tuple[int, str]:
    """pg_ctl stop -m fast（仅测试 / 运维显式调用；产品退出时**故意不停止** PG）。"""
    try:
        proc = __import__("subprocess").run(
            [
                str(bin_dir / "pg_ctl.exe"),
                "stop", "-m", "fast", "-w", "-t", "60",
                "-D", str(data_dir),
                "-s",
            ],
            stdout=__import__("subprocess").DEVNULL,
            stderr=__import__("subprocess").DEVNULL,
            stdin=__import__("subprocess").DEVNULL,
            timeout=90,
            **_no_window_kwargs(),
        )
    except Exception as exc:  # pragma: no cover - 仅测试辅助
        return 1, str(exc)
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
            "error": "PostgreSQL 运行时缺失（bin 目录不完整："
            + ", ".join(missing)
            + f"；目录 {pg_bin}）。请重新安装 StayOps Desktop。",
        }

    password = _ensure_creds(creds_file)

    def _step(msg: str) -> None:
        print(f"[db-ensure] {msg}", file=sys.stderr, flush=True)

    # 审计线索：Packaged Mode 下这里必须是 ASCII-safe materialized runtime
    # （%PROGRAMDATA%\StayOps\runtime\postgresql\<version>\pgsql\bin），
    # 而不是安装目录里的 resources\postgres\...（安装路径可能含中文）。
    _step(f"pg runtime bin: {pg_bin}")

    already_running = (data_dir / "PG_VERSION").exists() and _pg_connect_ok(
        pg_bin, port, password, "postgres"
    )
    initialized = False

    if not already_running:
        # 首次初始化
        if not (data_dir / "PG_VERSION").exists():
            state = classify_data_dir(data_dir)
            if state == DATA_DIR_UNKNOWN_NONEMPTY:
                # 绝不对「非空且非 StayOps 可识别的部分初始化目录」动手：
                # 既可能包含用户数据，也可能是别的程序目录。
                _step("data dir is non-empty without PG_VERSION → refuse to touch")
                return {
                    "ok": False,
                    "initialized": False,
                    "dbUrl": None,
                    "error": (
                        "数据目录非空且不包含有效的 PostgreSQL 数据（缺少 PG_VERSION）："
                        f"{data_dir}\n为避免破坏既有文件，StayOps 已停止初始化。"
                        "请人工确认该目录后重试（StayOps 不会自动删除它）。"
                    ),
                }
            if state == DATA_DIR_PARTIAL_FAILED_INIT:
                # 只清理「明确属于失败初始化」的部分 cluster：有 incomplete 标记、无 PG_VERSION
                cleaned, reason = clean_partial_data_dir(data_dir)
                _step(f"partial init cleanup: {reason}")
                if not cleaned:
                    return {
                        "ok": False,
                        "initialized": False,
                        "dbUrl": None,
                        "error": f"数据目录状态异常，已停止以避免误删：{reason}（目录 {data_dir}）",
                    }

            initialized = True
            _step("first run: initdb …")
            pwfile = data_dir.parent / ".stayops-pwfile.tmp"
            marker = init_marker_path(data_dir)
            try:
                data_dir.parent.mkdir(parents=True, exist_ok=True)
                # 历史残留：早期版本把标记写进了 data 目录 → 必须清掉，
                # 否则 initdb 会拒绝非空目录
                legacy_marker = data_dir / INIT_INCOMPLETE_MARKER
                if legacy_marker.exists():
                    try:
                        legacy_marker.unlink()
                    except OSError:
                        pass
                data_dir.mkdir(parents=True, exist_ok=True)
                # 初始化开始前落标记（在 data 目录**同级**）：
                # 只有它存在（且无 PG_VERSION）才允许重试清理
                marker.write_text("1\n", encoding="utf-8")
                pwfile.write_text(password + "\n", encoding="utf-8")
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
                # 失败：保留 incomplete 标记（下次可安全重试），且绝不删除含 PG_VERSION 的 cluster
                _step(f"initdb failed: {scrub_text(err.strip())[-200:]}")
                return {
                    "ok": False,
                    "initialized": True,
                    "dbUrl": None,
                    "error": "数据库初始化失败：" + scrub_text(err.strip())[-400:],
                }
            try:
                marker.unlink()
            except OSError:
                pass
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
# ai-key-ensure（每台安装独立的 AI_ENCRYPTION_KEY · §8 security）
#
# 背景：backend/app/config.py 带一个**公开可知的 dev 默认密钥**。安装版若沿用它，
# 用户保存的 DeepSeek API Key 就等于用公开密钥加密。因此 packaged 模式必须先确保
# 存在每台安装独立的随机 32 字节密钥，并由 Electron 注入 backend 子进程环境变量；
# 无法提供时 Desktop 直接 Fail Safe（不启动），绝不静默回退。
#
# 存储与保护（docs/DECISIONS.md 记录取舍）：
#   1. 首选 Windows DPAPI（CryptProtectData，当前用户作用域）：密文只能被同一台机器
#      的同一用户解密，拷贝到其它机器/用户无效；无需额外依赖（ctypes + crypt32）。
#   2. DPAPI 不可用时回退「随机密钥 + icacls 收紧 ACL 的明文文件」，并在结果中
#      明确标记 protection="acl"（security tradeoff 可见，不假装等价）。
#   3. 文件位于 %PROGRAMDATA%\StayOps\config\ai_encryption.key：不进 Git、不进安装包、
#      升级/重装/卸载默认保留。
# 密钥本身绝不写日志、绝不返回前端，只经进程管道交给 Electron 主进程。
# ---------------------------------------------------------------------------

AI_KEY_BYTES = 32
SECRET_DPAPI_PREFIX = "dpapi:"
SECRET_PLAIN_PREFIX = "plain:"


def _dpapi(protect: bool, data: bytes) -> bytes | None:
    """Windows DPAPI 加/解密（当前用户作用域）；不可用或失败返回 None。"""
    if os.name != "nt":
        return None
    try:
        import base64 as _b64
        import ctypes
        from ctypes import wintypes

        class _Blob(ctypes.Structure):
            _fields_ = [
                ("cbData", wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_char)),
            ]

        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        buf = ctypes.create_string_buffer(data, len(data))
        blob_in = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        blob_out = _Blob()
        fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
        if protect:
            ok = fn(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
        else:
            ok = fn(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
        if not ok:
            return None
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            kernel32.LocalFree(blob_out.pbData)
    except Exception:
        return None


def _write_secret_file(secret_file: Path, secret: str, use_dpapi: bool) -> str:
    """写入秘密文件，返回实际保护方式（dpapi / acl）。"""
    secret_file.parent.mkdir(parents=True, exist_ok=True)
    payload: str | None = None
    if use_dpapi:
        blob = _dpapi(True, secret.encode("utf-8"))
        if blob is not None:
            import base64 as _b64

            payload = SECRET_DPAPI_PREFIX + _b64.b64encode(blob).decode("ascii")
    protection = "dpapi"
    if payload is None:
        # DPAPI 不可用：明文 + ACL 收紧（tradeoff 已在结果中标注）
        payload = SECRET_PLAIN_PREFIX + secret
        protection = "acl"
    secret_file.write_text(payload + "\n", encoding="utf-8")
    if os.name == "nt":
        _tighten_acl(secret_file)
    return protection


def _read_secret_file(secret_file: Path) -> tuple[str | None, str]:
    """读取秘密文件，返回 (secret, protection)；不可读/损坏返回 (None, reason)。"""
    try:
        raw = secret_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        return None, f"无法读取密钥文件：{exc}"
    if not raw:
        return None, "密钥文件为空"
    if raw.startswith(SECRET_DPAPI_PREFIX):
        import base64 as _b64

        try:
            blob = _b64.b64decode(raw[len(SECRET_DPAPI_PREFIX):])
        except Exception:
            return None, "密钥文件格式损坏（base64）"
        plain = _dpapi(False, blob)
        if plain is None:
            return None, "DPAPI 解密失败（密钥由其它用户/机器创建？）"
        return plain.decode("utf-8"), "dpapi"
    if raw.startswith(SECRET_PLAIN_PREFIX):
        return raw[len(SECRET_PLAIN_PREFIX):], "acl"
    return None, "密钥文件格式无法识别"


def _new_ai_key() -> str:
    """生成 Fernet 兼容密钥：urlsafe base64(32 random bytes)。"""
    import base64 as _b64
    import secrets

    return _b64.urlsafe_b64encode(secrets.token_bytes(AI_KEY_BYTES)).decode("ascii")


def _try_write_secret(secret_file: Path, secret: str) -> tuple[str | None, str | None]:
    """写入秘密文件，返回 (protection, error)；绝不抛出（probe 必须返回结构化 JSON）。"""
    try:
        return _write_secret_file(secret_file, secret, use_dpapi=True), None
    except OSError as exc:
        return None, f"无法写入 {secret_file}（权限或磁盘错误）：{exc}"


def _prepare_config_dir(config_dir: Path) -> str | None:
    """准备安装级配置目录：可写自愈 + ACL 收紧。返回错误信息或 None。"""
    if not _ensure_dir_writable(config_dir):
        return (
            f"配置目录不可写：{config_dir}；ACL 自动修复失败，"
            "请以管理员身份重置该目录权限后重试。"
        )
    _tighten_acl(config_dir)
    return None


def cmd_ai_key_ensure(args: argparse.Namespace) -> dict:
    key_file = Path(args.key_file)
    config_dir = Path(args.config_dir)
    dir_error = _prepare_config_dir(config_dir)
    if dir_error:
        return {"ok": False, "created": False, "key": None, "protection": None, "error": dir_error}

    if key_file.exists():
        key, protection = _read_secret_file(key_file)
        if key:
            return {"ok": True, "created": False, "key": key, "protection": protection, "error": None}
        # 已存在但不可用：packaged 模式必须 Fail Safe，不覆盖（避免丢失已加密数据）
        return {"ok": False, "created": False, "key": None, "protection": None, "error": protection}

    key = _new_ai_key()
    protection, write_error = _try_write_secret(key_file, key)
    if write_error:
        return {"ok": False, "created": False, "key": None, "protection": None, "error": write_error}
    readback, readback_protection = _read_secret_file(key_file)
    if readback != key:
        return {
            "ok": False,
            "created": False,
            "key": None,
            "protection": protection,
            "error": f"密钥写入后校验失败（{readback_protection}）",
        }
    return {"ok": True, "created": True, "key": key, "protection": protection, "error": None}


# ---------------------------------------------------------------------------
# admin-bootstrap-ensure / seed-ensure（首次安装的 SUPER_ADMIN 引导凭据）
#
# 背景：seed.py 不再内置固定开发密码；安装版首次运行必须自行生成高强度随机
# 管理员密码并完成 seed（权限/角色/admin/房型/房间），否则干净机器上没有可登录账号。
#
# 安全约束（用户明确要求）：
#   - 密码只注入 seed 进程（不写入桌面/后端/前端日志，不进 stdout/stderr 之外的通道）
#   - 只允许在首次启动 UI 显示一次（created=True 时返回；已存在时不返回密码）
#   - 不明文落盘：DPAPI 用户作用域密文（不可用时降级为 ACL 收紧文件并在结果标注）
#   - 首次登录后应修改密码，随后可销毁 bootstrap 凭据（desktop 侧 pending 标记）
# ---------------------------------------------------------------------------

ADMIN_BOOTSTRAP_BYTES = 24


def _new_admin_password() -> str:
    """高强度随机密码（urlsafe base64，24 字节 ≈ 192 bit）。"""
    import secrets

    return secrets.token_urlsafe(ADMIN_BOOTSTRAP_BYTES)


def cmd_admin_bootstrap_ensure(args: argparse.Namespace) -> dict:
    bootstrap_file = Path(args.bootstrap_file)
    config_dir = Path(args.config_dir)
    dir_error = _prepare_config_dir(config_dir)
    if dir_error:
        return {"ok": False, "created": False, "password": None, "protection": None, "error": dir_error}

    if bootstrap_file.exists():
        password, protection = _read_secret_file(bootstrap_file)
        ok = password is not None
        # show-once：已存在的 bootstrap 密码不返回给 UI
        return {
            "ok": ok,
            "created": False,
            "password": None,
            "protection": protection if ok else None,
            "error": None if ok else protection,
        }

    password = _new_admin_password()
    protection, write_error = _try_write_secret(bootstrap_file, password)
    if write_error:
        return {"ok": False, "created": False, "password": None, "protection": None, "error": write_error}
    readback, readback_protection = _read_secret_file(bootstrap_file)
    if readback != password:
        return {
            "ok": False,
            "created": False,
            "password": None,
            "protection": protection,
            "error": f"bootstrap 凭据写入后校验失败（{readback_protection}）",
        }
    return {"ok": True, "created": True, "password": password, "protection": protection, "error": None}


def cmd_seed_ensure(args: argparse.Namespace) -> dict:
    """幂等执行 seed（权限/角色/admin/房型/房间）；bootstrap 密码只注入本进程。

    只有「admin 尚不存在」时才需要 bootstrap 凭据（干净机器首次安装）：
    - 不存在且无凭据 → 生成高强度随机密码（DPAPI 保护）并返回一次供 UI 显示
    - 不存在但有凭据 → 复用（不返回密码，show-once）
    - 已存在 → 直接幂等 seed（不需要密码，避免覆盖用户已改的密码）
    """
    bootstrap_file = Path(args.bootstrap_file)

    # Electron 以 cwd=backend 运行探针；backend 必须在 sys.path 上才能 import app.*
    backend_dir = Path.cwd()
    if not (backend_dir / "app" / "seed.py").exists():
        return {
            "ok": False,
            "seeded": False,
            "createdBootstrap": False,
            "bootstrapCleared": False,
            "password": None,
            "error": "无法定位 backend 目录（seed-ensure 必须以 cwd=backend 运行）",
        }
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))

    # 先判断 admin 是否已存在（需要 DATABASE_URL，由 Desktop 注入）
    try:
        from sqlalchemy import select

        from app.database import SessionLocal
        from app.models import User
        from app.seed import ADMIN_USERNAME

        with SessionLocal() as db:
            admin_exists = (
                db.scalar(select(User).where(User.username == ADMIN_USERNAME)) is not None
            )
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "seeded": False,
            "createdBootstrap": False,
            "bootstrapCleared": False,
            "password": None,
            "error": scrub_text(str(exc))[-400:],
        }

    created = False
    password: str | None = None
    bootstrap_cleared = False
    if admin_exists and bootstrap_file.exists():
        # §8：管理员仍存在 → 若 bootstrap 凭据已不再匹配当前密码哈希，
        # 说明用户已完成首次改密，立即销毁该凭据（不再保留任何引导凭据）。
        stored, _protection = _read_secret_file(bootstrap_file)
        if stored:
            try:
                from passlib.context import CryptContext

                from app.models import User as _User
                from app.seed import ADMIN_USERNAME as _ADMIN

                with SessionLocal() as db:
                    row = db.scalar(select(_User).where(_User.username == _ADMIN))
                    still_valid = bool(
                        row and CryptContext(schemes=["bcrypt"]).verify(stored, row.password_hash)
                    )
                if not still_valid:
                    bootstrap_file.unlink()
                    bootstrap_cleared = True
            except Exception:  # noqa: BLE001 - 回收失败不应阻断启动
                bootstrap_cleared = False

    if not admin_exists:
        if bootstrap_file.exists():
            password, protection = _read_secret_file(bootstrap_file)
            if not password:
                return {
                    "ok": False,
                    "seeded": False,
                    "createdBootstrap": False,
                    "bootstrapCleared": False,
                    "password": None,
                    "error": f"bootstrap 凭据不可用：{protection}",
                }
        else:
            password = _new_admin_password()
            protection, write_error = _try_write_secret(bootstrap_file, password)
            if write_error:
                return {
                    "ok": False,
                    "seeded": False,
                    "createdBootstrap": False,
                    "bootstrapCleared": False,
                    "password": None,
                    "error": write_error,
                }
            readback, readback_protection = _read_secret_file(bootstrap_file)
            if readback != password:
                return {
                    "ok": False,
                    "seeded": False,
                    "createdBootstrap": False,
                    "bootstrapCleared": False,
                    "password": None,
                    "error": f"bootstrap 凭据写入后校验失败（{readback_protection}）",
                }
            created = True
        # 仅注入本进程环境（父进程/子进程都不继承该变量）
        os.environ["STAYOPS_ADMIN_PASSWORD"] = password
        # 标记「安装版首次 seed」→ 管理员需强制改密（seed.py 据此置 must_change_password）
        os.environ["STAYOPS_ADMIN_BOOTSTRAP"] = "1"

    try:
        from app.seed import seed

        # probe 的 stdout 必须是纯 JSON：seed() 的人类可读输出全部截获丢弃
        # （否则 Electron 侧 probeJson 解析失败，成功的 seed 会被判为失败）
        import contextlib
        import io

        with contextlib.redirect_stdout(io.StringIO()):
            seed()
    except Exception as exc:  # noqa: BLE001 - 向上返回可读错误，不打印密码
        return {
            "ok": False,
            "seeded": False,
            "createdBootstrap": created,
            "bootstrapCleared": False,
            "password": None,
            "error": scrub_text(str(exc))[-400:],
        }
    finally:
        os.environ.pop("STAYOPS_ADMIN_PASSWORD", None)
        os.environ.pop("STAYOPS_ADMIN_BOOTSTRAP", None)

    return {
        "ok": True,
        "seeded": True,
        "createdBootstrap": created,
        "bootstrapCleared": bootstrap_cleared,
        "password": password if created else None,
        "error": None,
    }


def cmd_admin_bootstrap_clear(args: argparse.Namespace) -> dict:
    """首次修改密码成功后销毁 bootstrap 凭据（用户要求 §8）。"""
    bootstrap_file = Path(args.bootstrap_file)
    try:
        bootstrap_file.unlink()
    except FileNotFoundError:
        return {"ok": True, "cleared": False, "error": None}
    except OSError as exc:
        return {"ok": False, "cleared": False, "error": f"无法删除 bootstrap 凭据：{exc}"}
    return {"ok": True, "cleared": True, "error": None}


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
    p_aikey = sub.add_parser("ai-key-ensure", help="确保每台安装独立的 AI_ENCRYPTION_KEY")
    p_aikey.add_argument("--key-file", required=True, help="密钥文件路径")
    p_aikey.add_argument("--config-dir", required=True, help="安装级配置目录")
    p_admin = sub.add_parser("admin-bootstrap-ensure", help="确保首次安装的 bootstrap 管理员凭据")
    p_admin.add_argument("--bootstrap-file", required=True, help="bootstrap 凭据文件路径")
    p_admin.add_argument("--config-dir", required=True, help="安装级配置目录")
    p_seed = sub.add_parser("seed-ensure", help="幂等执行 seed（权限/角色/admin/房型/房间）")
    p_seed.add_argument("--bootstrap-file", required=True, help="bootstrap 凭据文件路径")
    p_clear = sub.add_parser("admin-bootstrap-clear", help="首次改密后销毁 bootstrap 凭据")
    p_clear.add_argument("--bootstrap-file", required=True, help="bootstrap 凭据文件路径")
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
    elif args.command == "ai-key-ensure":
        result = cmd_ai_key_ensure(args)
    elif args.command == "admin-bootstrap-ensure":
        result = cmd_admin_bootstrap_ensure(args)
    elif args.command == "seed-ensure":
        result = cmd_seed_ensure(args)
    elif args.command == "admin-bootstrap-clear":
        result = cmd_admin_bootstrap_clear(args)
    else:
        parser.error(f"未知命令: {args.command}")

    print(json.dumps(result, ensure_ascii=False), flush=True)
    ok = result.get("ok", result.get("state") in ("OK", "BEHIND", "MULTI_HEAD"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
