"""PostgreSQL 并发冲突 SQLSTATE 分类（Sprint 4 D1 修复，Sprint 5 复用）。

唯一权威（docs/DECISIONS.md Sprint 4 D1）：
- 23505 unique_violation        -> 业务唯一冲突（409）
- 23514 check_violation         -> 数据一致性约束冲突（409，防御性兜底）
- 23P01 exclusion_violation     -> 排他约束冲突（409）
- 40P01 deadlock_detected       -> 并发仲裁（409，绝不 500）
- 40001 serialization_failure   -> 事务序列化冲突（409，绝不 500）
- 其它任何 OperationalError（57014 query_canceled、无 pgcode、连接故障、
  库不可用等）-> rollback 后原样 re-raise，不得转换/吞掉。
"""

from sqlalchemy.exc import IntegrityError, OperationalError


def pgcode(exc: IntegrityError | OperationalError) -> str | None:
    """取底层 DBAPI 错误的 SQLSTATE。

    psycopg2：exc.orig.pgcode（连接抛出的真实错误必然携带）；
    回退 exc.orig.diag.sqlstate（防御个别驱动版本差异）。
    """
    orig = getattr(exc, "orig", None)
    if orig is None:
        return None
    code = getattr(orig, "pgcode", None)
    if code is None:
        diag = getattr(orig, "diag", None)
        code = getattr(diag, "sqlstate", None)
    return code


def is_transaction_conflict(exc: OperationalError) -> bool:
    """仅识别可转换为业务 Conflict 的 PostgreSQL 并发仲裁错误：
    40P01 deadlock_detected / 40001 serialization_failure。
    其它任何 OperationalError 一律不得转换 —— 必须 rollback 后原样 re-raise。
    """
    return pgcode(exc) in ("40P01", "40001")


def classify(exc: IntegrityError | OperationalError) -> str:
    """SQLSTATE 分类：唯一冲突 / 检查约束 / 排他约束 / 并发仲裁，其余原样。

    唯一权威（Sprint 4 D1，Sprint 5/7 复用）：
    - 23505 unique_violation      -> "unique"
    - 23514 check_violation       -> "check"
    - 23P01 exclusion_violation   -> "exclusion"
    - 40P01 / 40001               -> "transaction"
    - 其它                        -> "other"（不得转换为业务错误）
    """
    return {
        "23505": "unique",
        "23514": "check",
        "23P01": "exclusion",
        "40P01": "transaction",
        "40001": "transaction",
    }.get(pgcode(exc), "other")
