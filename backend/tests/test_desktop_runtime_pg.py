# -*- coding: utf-8 -*-
"""alpha.9.6 Windows runtime hotfix：Desktop PostgreSQL 运行时脚本的纯逻辑测试。

被测对象是工作区脚本（不是后端应用代码），但 pytest 是本仓库唯一会自动执行的
Python gate（`cd backend && pytest`），因此这里按路径导入被测模块，只测试
**纯函数**（不启动 PostgreSQL、不触碰真实数据目录）：

- `decode_pg_output`：PG CLI 输出稳健解码（UTF-8 → 系统 preferred encoding/mbcs
  → replacement），中文 Windows 下 PG 可能输出 ANSI codepage 文本
- `classify_data_dir` / `clean_partial_data_dir`：失败初始化残留的判定与守卫
  （没有 PG_VERSION 才允许清理；有 PG_VERSION 的 cluster 绝对不删）
- `desktop_db_backup`：备份/恢复工具的同一套 runtime resolver 与解码逻辑
"""

from __future__ import annotations

import importlib.util
import locale
import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"


def _load(module_name: str, path: Path):
    """按路径加载工作区脚本（scripts/ 不是 package）。"""
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# desktop_runtime.py 在导入时会 chdir 到 backend/ 并调整 sys.path
# （它是独立 CLI，设计如此）。这里恢复 cwd，避免影响后续测试。
_CWD = os.getcwd()
try:
    desktop_runtime = _load("stayops_desktop_runtime", SCRIPTS_DIR / "desktop_runtime.py")
finally:
    os.chdir(_CWD)

desktop_db_backup = _load("stayops_desktop_db_backup", SCRIPTS_DIR / "desktop_db_backup.py")

CHINESE_PATH = "D:/安客酒店试用软件/StayOps/resources/postgres/pgsql"
GBK_DECODABLE = True
try:
    CHINESE_PATH.encode("gbk")
except UnicodeEncodeError:  # pragma: no cover - GBK 之外的系统
    GBK_DECODABLE = False


# ---------------------------------------------------------------------------
# decode_pg_output
# ---------------------------------------------------------------------------


def test_decode_pg_output_prefers_utf8():
    """UTF-8 输出必须原样解出（第一优先，不乱码）。"""
    raw = "数据库初始化失败：路径 C:\\ProgramData\\StayOps".encode("utf-8")
    assert desktop_runtime.decode_pg_output(raw) == (
        "数据库初始化失败：路径 C:\\ProgramData\\StayOps"
    )


def test_decode_pg_output_empty_and_none():
    assert desktop_runtime.decode_pg_output(b"") == ""
    assert desktop_runtime.decode_pg_output(None) == ""


def test_decode_pg_output_ascii_initdb_failure():
    """复现中文路径下的真实 initdb 失败文本：纯 ASCII，必须原样保留。"""
    raw = b'FATAL:  invalid byte sequence for encoding "UTF8": 0xb0\n'
    assert desktop_runtime.decode_pg_output(raw) == (
        'FATAL:  invalid byte sequence for encoding "UTF8": 0xb0\n'
    )


@pytest.mark.skipif(not GBK_DECODABLE, reason="系统无 GBK 编码支持")
def test_decode_pg_output_gbk_fallback(monkeypatch):
    """ANSI codepage（GBK）输出不能变成乱码（第二优先）。"""
    raw = f"initdb: removing contents of data directory {CHINESE_PATH}".encode("gbk")
    # 模拟中文 Windows：preferred encoding 为 GBK/cp936
    monkeypatch.setattr(
        desktop_runtime, "_preferred_decodings", lambda: ("gbk", "mbcs", "cp1252")
    )
    assert desktop_runtime.decode_pg_output(raw) == (
        f"initdb: removing contents of data directory {CHINESE_PATH}"
    )


def test_decode_pg_output_never_raises_and_uses_replacement():
    """任何字节序列都必须能解出字符串（最后兜底 replacement，绝不抛异常）。"""
    raw = b"\xff\xfe\x00\xb0 breaking bytes"
    out = desktop_runtime.decode_pg_output(raw)
    assert isinstance(out, str)
    assert "breaking bytes" in out


def test_decode_pg_output_does_not_depend_on_console_codepage():
    """解码顺序稳定：UTF-8 优先，其次系统 preferred encoding（中文 Windows = cp936）。"""
    preferred = (locale.getpreferredencoding(False) or "").lower()
    raw = "安客酒店".encode("utf-8")
    assert desktop_runtime.decode_pg_output(raw) == "安客酒店"
    assert isinstance(preferred, str)  # 仅记录环境，不强制具体 codepage


# ---------------------------------------------------------------------------
# data dir 判定 / 部分初始化守卫
# ---------------------------------------------------------------------------


def test_classify_data_dir_states(tmp_path: Path):
    absent = tmp_path / "absent"
    empty = tmp_path / "empty"
    empty.mkdir()
    valid = tmp_path / "valid"
    (valid / "base").mkdir(parents=True)
    (valid / "PG_VERSION").write_text("16\n", encoding="utf-8")
    partial = tmp_path / "partial"
    (partial / "base").mkdir(parents=True)
    # 标记在 data 目录**同级**（放进 data 里会让 initdb 拒绝非空目录）
    desktop_runtime.init_marker_path(partial).write_text("1\n", encoding="utf-8")
    unknown = tmp_path / "unknown"
    unknown.mkdir()
    (unknown / "user-file.txt").write_text("do not delete me\n", encoding="utf-8")

    assert desktop_runtime.classify_data_dir(absent) == desktop_runtime.DATA_DIR_ABSENT
    assert desktop_runtime.classify_data_dir(empty) == desktop_runtime.DATA_DIR_EMPTY
    assert (
        desktop_runtime.classify_data_dir(valid)
        == desktop_runtime.DATA_DIR_VALID_CLUSTER
    )
    assert (
        desktop_runtime.classify_data_dir(partial)
        == desktop_runtime.DATA_DIR_PARTIAL_FAILED_INIT
    )
    assert (
        desktop_runtime.classify_data_dir(unknown)
        == desktop_runtime.DATA_DIR_UNKNOWN_NONEMPTY
    )


def test_init_marker_lives_outside_data_dir(tmp_path: Path):
    """回归保护：标记文件必须在 data 目录之外（initdb 要求 data 目录为空）。"""
    data_dir = tmp_path / "PostgreSQL" / "data"
    data_dir.mkdir(parents=True)
    marker = desktop_runtime.init_marker_path(data_dir)

    assert marker.parent == data_dir.parent
    assert marker.name == f"{data_dir.name}{desktop_runtime.INIT_INCOMPLETE_MARKER}"

    marker.write_text("1\n", encoding="utf-8")
    # data 目录本身仍然为空 → classify 认为可初始化（而不是"非空残留"）
    assert desktop_runtime.classify_data_dir(data_dir) == desktop_runtime.DATA_DIR_EMPTY


def test_classify_ignores_legacy_in_dir_marker(tmp_path: Path):
    """兼容早期缺陷版本：data 目录里只有遗留标记文件时仍视为空目录。"""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / desktop_runtime.INIT_INCOMPLETE_MARKER).write_text("1\n", encoding="utf-8")

    assert desktop_runtime.classify_data_dir(data_dir) == desktop_runtime.DATA_DIR_EMPTY


def test_valid_cluster_with_extra_files_is_never_partial(tmp_path: Path):
    """有 PG_VERSION 的目录即使混入其它文件也必须判为有效 cluster（绝不清理）。"""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "PG_VERSION").write_text("16\n", encoding="utf-8")
    desktop_runtime.init_marker_path(data_dir).write_text("1\n", encoding="utf-8")
    (data_dir / "postgresql.conf").write_text("# keep\n", encoding="utf-8")

    assert (
        desktop_runtime.classify_data_dir(data_dir)
        == desktop_runtime.DATA_DIR_VALID_CLUSTER
    )
    cleaned, reason = desktop_runtime.clean_partial_data_dir(data_dir)
    assert cleaned is False
    assert "PG_VERSION" in reason
    assert (data_dir / "postgresql.conf").exists()
    assert (data_dir / "PG_VERSION").exists()


def test_clean_partial_data_dir_requires_marker(tmp_path: Path):
    """没有 incomplete 标记的非空目录：拒绝清理，文件原样保留（Fail Safe）。"""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    keep = data_dir / "user-file.txt"
    keep.write_text("do not delete me\n", encoding="utf-8")

    cleaned, reason = desktop_runtime.clean_partial_data_dir(data_dir)

    assert cleaned is False
    assert "拒绝清理" in reason
    assert keep.read_text(encoding="utf-8") == "do not delete me\n"


def test_clean_partial_data_dir_cleans_marked_partial(tmp_path: Path):
    """有标记、无 PG_VERSION 的失败初始化残留：允许清理（标记本身在 data 之外）。"""
    data_dir = tmp_path / "data"
    (data_dir / "base").mkdir(parents=True)
    (data_dir / "base" / "1").write_text("partial\n", encoding="utf-8")
    (data_dir / "postmaster.pid").write_text("123\n", encoding="utf-8")
    desktop_runtime.init_marker_path(data_dir).write_text("1\n", encoding="utf-8")

    cleaned, reason = desktop_runtime.clean_partial_data_dir(data_dir)

    assert cleaned is True
    assert "无 PG_VERSION" in reason
    assert not (data_dir / "base").exists()
    assert not (data_dir / "postmaster.pid").exists()
    # 标记保留在 data 之外（重试初始化时会重写 / 成功后删除）
    assert desktop_runtime.init_marker_path(data_dir).exists()


def test_db_ensure_refuses_unknown_nonempty_dir_without_touching_it(tmp_path: Path):
    """`db-ensure` 对无法识别的非空数据目录：报可读错误且**不删除任何文件**。"""
    pg_bin = tmp_path / "bin"
    pg_bin.mkdir()
    for exe in ("pg_ctl.exe", "initdb.exe", "psql.exe", "pg_isready.exe"):
        (pg_bin / exe).write_text("stub", encoding="utf-8")
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    keep = data_dir / "important.txt"
    keep.write_text("precious\n", encoding="utf-8")

    args = desktop_runtime.argparse.Namespace(
        pg_bin=str(pg_bin),
        data_dir=str(data_dir),
        creds_file=str(tmp_path / "conf" / "dbpass.conf"),
        port=5433,
        timeout_ms=1000,
    )
    result = desktop_runtime.cmd_db_ensure(args)

    assert result["ok"] is False
    assert "数据目录非空" in result["error"]
    assert keep.read_text(encoding="utf-8") == "precious\n"


# ---------------------------------------------------------------------------
# desktop_db_backup：同一 runtime resolver + 同一解码策略
# ---------------------------------------------------------------------------


def _make_materialized_runtime(root: Path, version: str, *, complete: bool = True) -> Path:
    """构造一个 materialized runtime 布局（可选去掉 marker 模拟半复制）。"""
    pg_dir = root / version / "pgsql"
    (pg_dir / "bin").mkdir(parents=True, exist_ok=True)
    for exe in ("pg_dump.exe", "pg_restore.exe", "psql.exe"):
        (pg_dir / "bin" / exe).write_text("stub", encoding="utf-8")
    if complete:
        (pg_dir / desktop_db_backup.PG_RUNTIME_MARKER).write_text(
            '{"schema": 1, "version": "%s"}\n' % version, encoding="utf-8"
        )
    return pg_dir


def test_backup_resolver_ignores_half_copied_runtime(tmp_path: Path, monkeypatch):
    """无完整性标记的 runtime 目录不能被 pg_dump/pg_restore 使用。"""
    _make_materialized_runtime(tmp_path, "16.15", complete=False)
    monkeypatch.setattr(desktop_db_backup, "PG_RUNTIME_ROOT", tmp_path)

    bin_dir, version = desktop_db_backup._materialized_pg_bin()

    assert bin_dir is None
    assert version is None


def test_backup_resolver_prefers_highest_complete_version(tmp_path: Path, monkeypatch):
    _make_materialized_runtime(tmp_path, "16.15")
    _make_materialized_runtime(tmp_path, "17.2")
    monkeypatch.setattr(desktop_db_backup, "PG_RUNTIME_ROOT", tmp_path)

    bin_dir, version = desktop_db_backup._materialized_pg_bin()

    assert bin_dir == tmp_path / "17.2" / "pgsql" / "bin"
    assert version == "17.2"


def test_backup_resolver_explicit_pg_bin_wins(tmp_path: Path):
    bin_dir, source = desktop_db_backup.resolve_pg_bin(str(tmp_path / "custom" / "bin"))
    assert bin_dir == tmp_path / "custom" / "bin"
    assert "explicit" in source


def test_backup_resolver_development_mode_uses_workspace_runtime():
    """开发工作区（无 <root>/postgres 安装布局）→ 继续使用 runtime/postgres/pgsql/bin。"""
    bin_dir, source = desktop_db_backup.resolve_pg_bin(None)
    assert bin_dir == REPO_ROOT / "runtime" / "postgres" / "pgsql" / "bin"
    assert "development" in source


def test_backup_decode_matches_runtime_decode():
    """备份工具与 desktop_runtime 使用同一套解码策略。"""
    raw = b'FATAL:  invalid byte sequence for encoding "UTF8": 0xb0\n'
    assert desktop_db_backup.decode_pg_output(raw) == desktop_runtime.decode_pg_output(raw)
    assert desktop_db_backup.decode_pg_output(b"") == ""


def test_backup_tool_reports_resolver_source(tmp_path: Path, capsys, monkeypatch):
    """备份工具启动时打印实际使用的 runtime 路径（审计线索）。"""
    pg_bin = tmp_path / "bin"
    pg_bin.mkdir()
    (pg_bin / "pg_dump.exe").write_text("stub", encoding="utf-8")
    monkeypatch.setattr(
        sys,
        "argv",
        ["desktop_db_backup.py", "--pg-bin", str(pg_bin), "--restore", str(tmp_path / "x.dump")],
    )

    code = desktop_db_backup.main()

    out = capsys.readouterr().out
    assert "PostgreSQL runtime" in out
    assert "explicit" in out
    # 未加 --yes 的恢复必须被拒绝（破坏性操作保护不变）
    assert code == 1
