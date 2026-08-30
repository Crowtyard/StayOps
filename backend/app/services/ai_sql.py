"""AI 只读 SQL 执行器（Sprint 9 §13/§15/§30）。

双层保护：
- 第一层：app.core.ai_sql_validator.validate_sql（词法级白名单校验，写语句
  执行前拒绝）。
- 第二层（数据库级）：使用独立只读 Role `stayops_ai_reader` 连接 +
  `SET TRANSACTION READ ONLY` + `statement_timeout` + 行数上限。
  即使绕过应用 Validator，PostgreSQL 自身仍拒绝 INSERT/UPDATE/DELETE/
  TRUNCATE/CREATE/ALTER/DROP（permission denied / read-only transaction）。

限制（§15）：
- READ ONLY 事务
- statement_timeout（settings.ai_sql_statement_timeout_ms，超时 -> AI_SQL_TIMEOUT）
- 行数上限：默认 ai_sql_max_rows（200），硬上限 500（settings.ai_sql_max_rows_hard_limit）
- 结果列/行 JSON 安全序列化（Decimal/date/datetime -> 字符串）
"""

from __future__ import annotations

import threading
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url
from sqlalchemy.exc import SQLAlchemyError

from app.config import settings
from app.core.ai_sql_validator import SqlValidationError, validate_sql

_reader_engine = None
_engine_lock = threading.Lock()


class AiSqlError(Exception):
    """AI SQL 执行错误（code: AI_SQL_*）。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _get_reader_engine():
    """stayops_ai_reader 只读连接（惰性创建；密码来自后端配置，绝不进 Prompt/日志）。"""
    global _reader_engine
    with _engine_lock:
        if _reader_engine is None:
            url = make_url(settings.database_url).set(
                username="stayops_ai_reader",
                password=settings.ai_reader_database_password,
            )
            _reader_engine = create_engine(url, pool_pre_ping=True)
        return _reader_engine


def _json_safe(value):
    """结果值 JSON 安全化（模型消费；禁止 Decimal/date 直出）。"""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def _sanitize_db_message(message: str) -> str:
    """截断数据库错误消息（防查询文本/环境细节泄漏进模型上下文）。"""
    return message[:300]


def execute_ai_query(
    sql: str,
    *,
    allowed_tables: set[str],
    limit: int | None = None,
) -> dict:
    """校验并只读执行 AI SQL。

    返回 {"columns": [...], "rows": [[...]], "row_count": n, "truncated": bool}。
    校验失败 -> SqlValidationError；执行失败 -> AiSqlError。
    """
    cleaned = validate_sql(sql, allowed_tables)
    max_rows = min(
        limit if limit is not None else settings.ai_sql_max_rows,
        settings.ai_sql_max_rows_hard_limit,
    )
    engine = _get_reader_engine()
    wrapped = f"SELECT * FROM (\n{cleaned}\n) AS _ai_result LIMIT {max_rows}"

    try:
        with engine.connect() as conn:
            conn.execute(text("SET TRANSACTION READ ONLY"))
            conn.execute(
                text(
                    f"SET LOCAL statement_timeout = {settings.ai_sql_statement_timeout_ms}"
                )
            )
            result = conn.execute(text(wrapped))
            columns = list(result.keys())
            rows = [[_json_safe(v) for v in row] for row in result.fetchall()]
    except SqlValidationError:
        raise
    except SQLAlchemyError as exc:
        orig = getattr(exc, "orig", None)
        pgcode = getattr(orig, "pgcode", None) or ""
        message = _sanitize_db_message(str(exc))
        if pgcode == "57014":
            raise AiSqlError(
                "AI_SQL_TIMEOUT",
                f"查询超时（statement_timeout={settings.ai_sql_statement_timeout_ms}ms）",
            ) from exc
        raise AiSqlError("AI_SQL_ERROR", f"数据库拒绝执行：{message}") from exc

    row_count = len(rows)
    truncated = row_count >= max_rows
    return {
        "columns": columns,
        "rows": rows,
        "row_count": row_count,
        "truncated": truncated,
    }
