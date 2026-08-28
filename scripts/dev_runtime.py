# -*- coding: utf-8 -*-
"""StayOps Local Development Runtime Supervisor（Alpha.5 Local Runtime Hardening）。

统一本地开发入口（由 start-dev.cmd 调用，不要求 PowerShell）：

    Runtime preflight（Git / Port / Backend URL / 必需文件）
    -> Migration check（stayops 开发库，默认 CHECK ONLY，--migrate 可选升级）
    -> Start Backend（.venv uvicorn --reload，127.0.0.1:8000）
    -> Start Frontend（pnpm.cmd dev，localhost:3000）
    -> Readiness verification（/health + /openapi.json 核心路由 + /login）
    -> Runtime summary

设计目标（事故：新 Frontend + 旧 Backend + 错误数据库版本组成「看似能运行」的
StayOps）：
- 端口 8000 / 3000 被占用 -> 显式 FAIL FAST（显示 PID，绝不 taskkill 未知进程）
- 开发库 migration current != head -> 默认停止并给出命令；--migrate 才升级
- Backend 必须 --reload；Frontend 用 .env.local 的 BACKEND_API_URL
- 启动后不立即宣称 READY：轮询 /health、/openapi.json（核心业务路由必须在，
  不做「路由数 == 44」这类会过期判断）、/login
- Ctrl+C / stdin EOF -> 尽力关闭 Backend + Frontend 整个进程树，不留 stale uvicorn
- --check：只做检查不启动服务（诊断用）

仅使用 Python 标准库 + Windows 系统工具（netstat / taskkill 只用于报告 PID 与
清理本进程自己启动的子进程树），不新增第三方依赖，不引入 process manager。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# Windows 控制台默认 GBK：强制 UTF-8 输出避免中文乱码（与 app.seed 同策略）
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
FRONTEND_DIR = ROOT / "frontend"
VENV_PYTHON = BACKEND_DIR / ".venv" / "Scripts" / "python.exe"

BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8000
FRONTEND_HOST = "localhost"
FRONTEND_PORT = 3000

BACKEND_READY_TIMEOUT = 90
FRONTEND_READY_TIMEOUT = 240

# 已发布核心领域路由（只验存在性；不写死总路由数，防止未来加路由即过期）
CORE_ROUTES = (
    "/api/v1/rooms",
    "/api/v1/reservations",
    "/api/v1/housekeeping/tasks",
    "/api/v1/maintenance/orders",
)

CREATE_NEW_PROCESS_GROUP = 0x00000200 if os.name == "nt" else 0

# 非错误：开发期普通修改提示阈值（超出仅截断展示）
_DIRTY_LIST_LIMIT = 12


def log(section: str, message: str) -> None:
    """带时间戳输出。

    父进程意外退出导致 stdout 管道断裂（BrokenPipeError）时静默忽略 ——
    停止/清理路径必须仍能完成，绝不能因打印失败而遗留 stale 进程。
    """
    ts = datetime.now().strftime("%H:%M:%S")
    try:
        print(f"[{ts}] [{section}] {message}", flush=True)
    except (OSError, ValueError):
        pass


def safe_print(text: str = "") -> None:
    """print 的 BrokenPipe 免疫版本（运行摘要在管道断裂时不得中断清理）。"""
    try:
        print(text, flush=True)
    except (OSError, ValueError):
        pass


def run_capture(cmd: list[str], cwd: Path | None) -> subprocess.CompletedProcess:
    """运行命令并捕获输出（本项目自建子进程，标准库 subprocess）。"""
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


# ---------------------------------------------------------------------------
# Preflight · Git
# ---------------------------------------------------------------------------


def git_check() -> dict:
    """分支 / HEAD / 精确 tag / 工作区状态摘要（.kun-canvas/ 不算错误）。"""
    info: dict = {"branch": None, "head": None, "tag": None, "dirty": []}
    if shutil.which("git") is None:
        return info

    branch = run_capture(["git", "rev-parse", "--abbrev-ref", "HEAD"], ROOT)
    if branch.returncode == 0:
        info["branch"] = branch.stdout.strip()

    head = run_capture(["git", "rev-parse", "--short", "HEAD"], ROOT)
    if head.returncode == 0:
        info["head"] = head.stdout.strip()

    tag = run_capture(
        ["git", "describe", "--tags", "--exact-match", "HEAD"], ROOT
    )
    if tag.returncode == 0:
        info["tag"] = tag.stdout.strip()

    status = run_capture(["git", "status", "--porcelain"], ROOT)
    if status.returncode == 0:
        for line in status.stdout.splitlines():
            if not line.strip():
                continue
            # .kun-canvas/ 为开发画布目录，不作为错误或提示
            if ".kun-canvas" in line:
                continue
            info["dirty"].append(line.strip())
    return info


def print_git(info: dict) -> bool:
    ok = info["branch"] is not None
    if not ok:
        log("GIT", "WARNING 未检测到 git（不影响启动，但无法校验版本一致性）")
        return True
    print()
    print("StayOps Local Runtime")
    print(f"Branch:   {info['branch']}")
    print(f"HEAD:     {info['head']}")
    print(f"Release:  {info['tag'] or '（当前 HEAD 无精确 tag）'}")
    if info["dirty"]:
        shown = info["dirty"][:_DIRTY_LIST_LIMIT]
        extra = len(info["dirty"]) - len(shown)
        log("GIT", "WARNING 工作区存在未提交修改（仅提示，不阻止开发启动）：")
        for item in shown:
            print(f"    {item}")
        if extra > 0:
            print(f"    ... 及另外 {extra} 项")
    else:
        print("Working Tree: clean")
    return True


# ---------------------------------------------------------------------------
# Preflight · Port Safety
# ---------------------------------------------------------------------------


def port_in_use(host: str, port: int) -> bool:
    """TCP 连接探测（标准库 socket；显式 FAIL，不让系统偷偷连旧服务）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(1.0)
        try:
            sock.connect((host, port))
            return True
        except OSError:
            return False


def pid_for_port(port: int) -> str | None:
    """Windows 标准工具 netstat 查询监听端口 PID（只读，不杀进程）。"""
    if os.name != "nt":
        return None
    proc = run_capture(["netstat", "-ano", "-p", "TCP"], None)
    if proc.returncode != 0:
        return None
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        if parts[1].endswith(f":{port}") and parts[3] == "LISTENING":
            return parts[4]
    return None


def check_ports(fail: bool = True) -> bool:
    ok = True
    for host, port, label in (
        (BACKEND_HOST, BACKEND_PORT, "Backend"),
        (FRONTEND_HOST, FRONTEND_PORT, "Frontend"),
    ):
        if not port_in_use(host, port):
            log("PORT", f"{label} 端口 {port} 空闲 OK")
            continue
        pid = pid_for_port(port)
        pid_text = f"（PID {pid}）" if pid else ""
        print()
        print(f"ERROR")
        print(f"Port {port} is already in use {pid_text}.")
        print()
        print("A stale StayOps backend may still be running.")
        print("Stop the old process and retry.")
        print()
        log("PORT", f"FAIL {label} 端口 {port} 已被占用 {pid_text}")
        ok = False
        if fail:
            break
    return ok


# ---------------------------------------------------------------------------
# Preflight · Dev Database Migration Check（stayops，不是 stayops_test）
# ---------------------------------------------------------------------------


def _alembic(cmd: list[str]) -> tuple[bool, str]:
    proc = run_capture([str(VENV_PYTHON), "-m", "alembic", *cmd], BACKEND_DIR)
    return proc.returncode == 0, proc.stdout + proc.stderr


def migration_check() -> tuple[str, str | None, str | None]:
    """返回 (状态, current_revision, head_revision)。

    状态 ∈ OK / BEHIND / ERROR；比较 alembic current 与 heads（默认 CHECK ONLY）。
    """
    ok_current, out_current = _alembic(["current"])
    ok_heads, out_heads = _alembic(["heads"])
    if not (ok_current and ok_heads):
        detail = (out_current + out_heads).strip()
        log("MIGRATION", f"FAIL 无法读取 Alembic 状态：{detail[:300]}")
        return "ERROR", None, None

    def _revision(text: str) -> str | None:
        for line in reversed(text.splitlines()):
            token = line.strip().split()
            if token and len(token[0]) == 12 and token[0].isalnum():
                return token[0]
        return None

    current = _revision(out_current)
    head = _revision(out_heads)
    if current is None or head is None:
        log("MIGRATION", f"FAIL 解析失败\ncurrent:\n{out_current}\nheads:\n{out_heads}")
        return "ERROR", current, head
    if current != head:
        return "BEHIND", current, head
    return "OK", current, head


def migration_upgrade() -> tuple[bool, str]:
    ok, out = _alembic(["upgrade", "head"])
    return ok, out


# ---------------------------------------------------------------------------
# Preflight · Frontend Backend URL 配置
# ---------------------------------------------------------------------------


def backend_url_check() -> tuple[bool, str]:
    """frontend/.env.local 的 BACKEND_API_URL 必须指向本启动器管理的后端。"""
    env_local = FRONTEND_DIR / ".env.local"
    if not env_local.exists():
        return True, "WARNING frontend/.env.local 不存在（前端可能启动失败，由 Readiness 兜底）"
    url = None
    for line in env_local.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith("BACKEND_API_URL="):
            url = line.split("=", 1)[1].strip().strip('"').strip("'")
            break
    if url is None:
        return True, "WARNING .env.local 未配置 BACKEND_API_URL（前端可能启动失败）"
    expected = f"http://{BACKEND_HOST}:{BACKEND_PORT}"
    if url.rstrip("/").lower() != expected:
        return (
            False,
            f"FAIL frontend/.env.local 的 BACKEND_API_URL={url}，"
            f"与本启动器管理的后端 {expected} 不一致",
        )
    return True, f"OK {url}"


# ---------------------------------------------------------------------------
# Preflight · 必需文件
# ---------------------------------------------------------------------------


def required_files_check() -> bool:
    checks = [
        (VENV_PYTHON, "backend/.venv/Scripts/python.exe"),
        (FRONTEND_DIR / "node_modules", "frontend/node_modules"),
        (FRONTEND_DIR / ".env.local", "frontend/.env.local"),
        (FRONTEND_DIR / "package.json", "frontend/package.json"),
    ]
    ok = True
    for path, label in checks:
        if path.exists():
            log("FILES", f"OK {label}")
        else:
            log("FILES", f"FAIL 缺少 {label}")
            ok = False
    if shutil.which("pnpm.cmd") is None and shutil.which("pnpm") is None:
        log("FILES", "FAIL 未找到 pnpm（需要 pnpm.cmd 可执行）")
        ok = False
    return ok


# ---------------------------------------------------------------------------
# Readiness
# ---------------------------------------------------------------------------


def _http_get(url: str, timeout: float = 2.0) -> tuple[int, str | None]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except (urllib.error.URLError, OSError):
        return 0, None


def wait_http(url: str, timeout: int, label: str) -> tuple[bool, str | None]:
    deadline = time.monotonic() + timeout
    last = 0
    while time.monotonic() < deadline:
        code, body = _http_get(url)
        if code == 200:
            return True, body
        if code != last:
            log("READY", f"{label} 尚未就绪（HTTP {code or '无响应'}），继续等待…")
            last = code
        time.sleep(1.5)
    return False, None


def core_routes_ok() -> tuple[bool, str]:
    code, body = _http_get(f"http://{BACKEND_HOST}:{BACKEND_PORT}/openapi.json")
    if code != 200 or not body:
        return False, "openapi.json 不可读"
    try:
        paths = set(json.loads(body).get("paths", {}).keys())
    except (ValueError, AttributeError):
        return False, "openapi.json 解析失败"
    missing = [
        r for r in CORE_ROUTES
        if not any(p == r or p.startswith(r + "/") for p in paths)
    ]
    if missing:
        return False, f"缺少核心业务路由：{', '.join(missing)}（当前 Backend 疑似过旧）"
    return True, "OK"


# ---------------------------------------------------------------------------
# 进程树启停（标准库 + 系统工具；只清理本启动器自己启动的进程树）
# ---------------------------------------------------------------------------


def _stop_process_tree(proc: subprocess.Popen, label: str) -> None:
    if proc.poll() is not None:
        log("STOP", f"{label} 已自行退出")
        return
    # 1) 优雅：向独立进程组发送 Ctrl+C（共享同一控制台时生效）
    if os.name == "nt":
        try:
            os.kill(proc.pid, signal.CTRL_C_EVENT)
        except OSError:
            pass
        except Exception:
            pass
        _wait_exit(proc, 4.0, label, "Ctrl+C")
    # 2) 本进程树内的系统工具清理（仅自己启动的 PID）
    if proc.poll() is None:
        log("STOP", f"{label} 未响应 Ctrl+C，尝试 taskkill /T（仅本启动器子进程树）…")
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T"],
            capture_output=True,
        )
        _wait_exit(proc, 4.0, label, "taskkill /T")
    if proc.poll() is None:
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
        )
        _wait_exit(proc, 4.0, label, "taskkill /T /F")
    if proc.poll() is not None:
        log("STOP", f"{label} 已停止")
    else:
        log("STOP", f"WARNING {label} 进程（PID {proc.pid}）未能确认退出")


def _wait_exit(proc: subprocess.Popen, seconds: float, label: str, method: str) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and proc.poll() is None:
        time.sleep(0.2)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


class RuntimeSupervisor:
    def __init__(self) -> None:
        self.backend: subprocess.Popen | None = None
        self.frontend: subprocess.Popen | None = None
        self.stopped = False

    # -- 启动 ---------------------------------------------------------------

    def start_backend(self) -> None:
        log("START", "启动 Backend（.venv uvicorn --reload，127.0.0.1:8000）…")
        self.backend = subprocess.Popen(
            [
                str(VENV_PYTHON),
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                BACKEND_HOST,
                "--port",
                str(BACKEND_PORT),
                "--reload",
            ],
            cwd=str(BACKEND_DIR),
            creationflags=CREATE_NEW_PROCESS_GROUP,
        )

    def start_frontend(self) -> None:
        log("START", "启动 Frontend（pnpm.cmd dev，localhost:3000）…")
        self.frontend = subprocess.Popen(
            ["cmd", "/c", "pnpm.cmd", "dev"],
            cwd=str(FRONTEND_DIR),
            creationflags=CREATE_NEW_PROCESS_GROUP,
        )

    # -- 就绪 ---------------------------------------------------------------

    def wait_backend(self) -> bool:
        ok, _ = wait_http(
            f"http://{BACKEND_HOST}:{BACKEND_PORT}/health",
            BACKEND_READY_TIMEOUT,
            "Backend /health",
        )
        if not ok:
            log("READY", "FAIL Backend /health 在超时内未就绪")
            return False
        ok, detail = core_routes_ok()
        if not ok:
            log("READY", f"FAIL {detail}")
            return False
        log("READY", f"Backend 就绪：/health OK，/openapi.json 核心路由 {detail}")
        return True

    def wait_frontend(self) -> bool:
        ok, _ = wait_http(
            f"http://{FRONTEND_HOST}:{FRONTEND_PORT}/login",
            FRONTEND_READY_TIMEOUT,
            "Frontend /login",
        )
        if not ok:
            print()
            log("READY", "FRONTEND START FAILED")
            print()
            log("STOP", "关闭已启动的 Backend…")
            self.shutdown()
            return False
        log("READY", "Frontend 就绪：/login HTTP 200")
        return True

    # -- 停止 ---------------------------------------------------------------

    def shutdown(self) -> None:
        if self.stopped:
            return
        self.stopped = True
        log("STOP", "正在停止 StayOps（Backend + Frontend 进程树）…")
        if self.frontend is not None:
            _stop_process_tree(self.frontend, "Frontend")
        if self.backend is not None:
            _stop_process_tree(self.backend, "Backend")
        time.sleep(1.0)
        for port in (BACKEND_PORT, FRONTEND_PORT):
            if port_in_use(BACKEND_HOST if port == BACKEND_PORT else FRONTEND_HOST, port):
                log("STOP", f"WARNING 端口 {port} 仍被占用")
            else:
                log("STOP", f"端口 {port} 已释放")

    # -- 运行 ---------------------------------------------------------------

    def run(self, migrate: bool) -> int:
        # ---- Preflight：Git ----
        git_info = git_check()
        print_git(git_info)

        # ---- Preflight：Port Safety（显式失败，不偷偷连旧服务）----
        if not check_ports():
            return 1

        # ---- Preflight：Backend URL / 必需文件 ----
        url_ok, url_msg = backend_url_check()
        log("CONFIG", url_msg)
        if not url_ok:
            return 1
        if not required_files_check():
            return 1

        # ---- Migration check（stayops 开发库；默认 CHECK ONLY）----
        state, current, head = migration_check()
        if state == "ERROR":
            return 1
        if state == "BEHIND":
            if not migrate:
                print()
                print("Database migration is behind.")
                print(f"Current:  {current}")
                print(f"Required: {head}")
                print("Run:")
                print("    alembic upgrade head")
                print()
                print("或使用 start-dev.cmd --migrate 显式升级后启动。")
                print()
                log("MIGRATION", "FAIL 开发库 schema 落后，已停止（默认 CHECK ONLY）")
                return 1
            log("MIGRATION", f"current {current} 落后于 head {head}，执行 --migrate 升级…")
            ok, out = migration_upgrade()
            if not ok:
                log("MIGRATION", f"FAIL upgrade head 失败：{out.strip()[-400:]}")
                return 1
            state, current, head = migration_check()
            if state != "OK":
                log("MIGRATION", "FAIL 升级后校验未通过")
                return 1
        log("MIGRATION", f"Database migration: OK（current == head == {head}）")

        # ---- 启动 ----
        self.start_backend()
        if not self.wait_backend():
            self.shutdown()
            return 1
        self.start_frontend()
        if not self.wait_frontend():
            # wait_frontend 内部已关闭 Backend
            return 1

        safe_print()
        safe_print("=====================================")
        safe_print("StayOps Development Runtime READY")
        safe_print("=====================================")
        safe_print(f"Version:   {git_info['tag'] or '（开发 HEAD）'}")
        safe_print(f"Git:       {git_info['head'] or '-'}")
        safe_print("Database:  stayops")
        safe_print(f"Alembic:   {head}")
        safe_print(f"Backend:   http://{BACKEND_HOST}:{BACKEND_PORT}  READY (--reload)")
        safe_print(f"Frontend:  http://{FRONTEND_HOST}:{FRONTEND_PORT}  READY")
        safe_print("Core APIs:")
        for route in CORE_ROUTES:
            domain = route.rsplit("/", 1)[-1]
            safe_print(f"    {domain:12s} OK")
        safe_print()
        safe_print("Press Ctrl+C to stop StayOps.")
        safe_print()

        # ---- 等待 Ctrl+C / stdin EOF ----
        try:
            if sys.stdin is not None and not sys.stdin.isatty():
                # 管道/重定向场景：EOF 视为停止请求（与 Ctrl+C 同一清理路径）
                threading.Thread(
                    target=self._stdin_watchdog, daemon=True
                ).start()
            while True:
                time.sleep(0.5)
        except KeyboardInterrupt:
            log("STOP", "收到 Ctrl+C")
        finally:
            self.shutdown()
        return 0

    def _stdin_watchdog(self) -> None:
        """stdin EOF（重定向/管道场景）= 与 Ctrl+C 相同的 orderly shutdown。

        log 已对 BrokenPipe 免疫，shutdown 在无 stdout 的环境下也能完整执行。
        """
        try:
            sys.stdin.buffer.read()
        except Exception:
            pass
        if not self.stopped:
            log("STOP", "stdin 已关闭（EOF），按 Ctrl+C 同路径停止")
            self.shutdown()
            os._exit(0)


def run_check() -> int:
    """--check：只做检查，不启动服务。"""
    print("StayOps Local Runtime -- CHECK MODE（不启动服务）")
    print()
    info = git_check()
    print_git(info)
    ports_ok = check_ports(fail=False)
    url_ok, url_msg = backend_url_check()
    log("CONFIG", url_msg)
    files_ok = required_files_check()
    state, current, head = migration_check()
    if state == "OK":
        log("MIGRATION", f"Database migration: OK（current == head == {head}）")
    elif state == "BEHIND":
        log("MIGRATION", f"FAIL 开发库 schema 落后：current {current} < head {head}（run: alembic upgrade head）")
    else:
        log("MIGRATION", "FAIL 无法确认开发库 migration 状态")

    print()
    all_ok = ports_ok and url_ok and files_ok and state == "OK"
    print(f"CHECK RESULT: {'PASS' if all_ok else 'FAIL'}")
    return 0 if all_ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="StayOps Local Development Runtime Supervisor"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="仅执行 Git/端口/配置/文件/migration 检查，不启动服务",
    )
    parser.add_argument(
        "--migrate",
        action="store_true",
        help="开发库 migration 落后时显式执行 alembic upgrade head 后再启动（默认 CHECK ONLY）",
    )
    args = parser.parse_args()

    if args.check:
        return run_check()

    supervisor = RuntimeSupervisor()
    return supervisor.run(migrate=args.migrate)


if __name__ == "__main__":
    sys.exit(main())
