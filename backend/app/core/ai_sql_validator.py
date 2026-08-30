"""AI 只读 SQL Validator（Sprint 9 §14/§31）。

安全模型（双层保护）：
- 本 Validator 是第一层：词法级（tokenizer）校验，Alpha.9 只允许
  SELECT / WITH ... SELECT；任何写/DDL/DCL/管理语句在执行前被拒绝。
- 第二层是数据库级：stayops_ai_reader 只读 Role + 只读事务（见
  app/services/ai_sql.py），即使 Validator 失效数据库自身仍拒绝写操作。

实现原则（§14）：
- 不用脆弱 substring（"if 'delete' in sql" 会误伤 deleted_at），
  采用完整词法扫描：字符串（含 '' 转义）、双引号标识符、行/块注释、
  dollar-quote（$tag$...$tag$）全部正确跳过后再做关键字判断。
- 数据修改型 CTE（WITH x AS (DELETE ...) SELECT ...）由「写关键字全
  文拒绝」兜底；SELECT INTO / SET / SHOW 等一律拒绝。
- 单次只能一个 Query：顶层分号分隔多条语句 -> 拒绝（允许单个结尾分号）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

SQL_MAX_LENGTH = 8000

# 任何位置出现即拒绝的语句级关键字（覆盖写/DDL/DCL/管理/参数修改）
FORBIDDEN_KEYWORDS: frozenset[str] = frozenset(
    {
        "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE",
        "CREATE", "ALTER", "DROP", "GRANT", "REVOKE", "COPY", "CALL", "DO",
        "SET", "INTO", "EXECUTE", "PREPARE", "DEALLOCATE",
        "VACUUM", "REINDEX", "CLUSTER", "REFRESH", "COMMENT", "SECURITY",
        "LOCK", "LISTEN", "NOTIFY", "UNLISTEN", "DISCARD", "RESET", "SHOW",
        "DECLARE", "MOVE", "CLOSE", "IMPORT", "ANALYZE",
    }
)

# 敏感字段/凭据标识符（任何位置出现即拒绝；视图层已物理排除，此为纵深防御）
FORBIDDEN_IDENTIFIERS: frozenset[str] = frozenset(
    {
        "PASSWORD", "PASSWORD_HASH", "PHONE", "EMAIL", "WECHAT",
        "ID_CARD", "CREDENTIAL", "CREDENTIALS", "SECRET", "TOKEN",
        "API_KEY", "APIKEY",
    }
)

_TABLE_PREFIX_KEYWORDS = frozenset({"FROM", "JOIN"})

# 表引用后不允许被误判为表名的关键字（子句/别名引导词）
_RESERVED_AFTER_TABLE = frozenset(
    {
        "AS", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET",
        "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "LATERAL",
        "ON", "USING", "UNION", "INTERSECT", "EXCEPT", "FETCH", "FOR",
        "WINDOW", "FROM", "SET", "RETURNING",
    }
)


class SqlValidationError(Exception):
    """SQL 校验失败（拒绝执行）。"""


@dataclass(frozen=True)
class _Token:
    word: str | None   # 标识符/关键字（大写）；字符串/符号为 None
    text: str          # 原始文本


def _find_dollar_quote_end(sql: str, start: int) -> int:
    """查找 $tag$...$tag$ 的结束位置；未闭合返回 len(sql)。"""
    m = re.match(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$", sql[start:])
    if not m:
        return start + 1
    tag = m.group(0)
    end = sql.find(tag, start + len(tag))
    return len(sql) if end == -1 else end + len(tag)


def tokenize(sql: str) -> list[_Token]:
    """词法扫描：返回关键字/标识符与符号序列（空白/字符串/注释/dollar-quote 已跳过）。"""
    tokens: list[_Token] = []
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        # 空白
        if ch.isspace():
            i += 1
            continue
        # 行注释
        if ch == "-" and i + 1 < n and sql[i + 1] == "-":
            end = sql.find("\n", i)
            i = n if end == -1 else end + 1
            continue
        # 块注释
        if ch == "/" and i + 1 < n and sql[i + 1] == "*":
            end = sql.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        # 单引号字符串（'' 转义）
        if ch == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            tokens.append(_Token(None, sql[i : min(j + 1, n)]))
            i = j + 1
            continue
        # dollar-quote 字符串
        if ch == "$":
            end = _find_dollar_quote_end(sql, i)
            tokens.append(_Token(None, sql[i:end]))
            i = end
            continue
        # 双引号标识符（原样保留，大小写敏感，不参与关键字判断）
        if ch == '"':
            j = i + 1
            while j < n and sql[j] != '"':
                j += 1
            tokens.append(_Token(None, sql[i : min(j + 1, n)]))
            i = j + 1
            continue
        # 标识符 / 关键字
        if ch.isalpha() or ch == "_":
            j = i + 1
            while j < n and (sql[j].isalnum() or sql[j] in "_$"):
                j += 1
            tokens.append(_Token(sql[i:j].upper(), sql[i:j]))
            i = j
            continue
        # 数字 / 其它符号（含分号）
        if ch.isdigit():
            j = i + 1
            while j < n and (sql[j].isdigit() or sql[j] == "."):
                j += 1
            tokens.append(_Token(None, sql[i:j]))
            i = j
            continue
        tokens.append(_Token(None, ch))
        i += 1
    return tokens


def _split_statements(tokens: list[_Token]) -> list[list[_Token]]:
    """单语句约束：只允许 0 或 1 个结尾分号；出现任何其它分号 -> 拒绝。"""
    semicolons = [i for i, tok in enumerate(tokens) if tok.text == ";"]
    if not semicolons:
        return [tokens]
    if semicolons == [len(tokens) - 1]:
        return [tokens[:-1]]
    raise SqlValidationError("只允许单条 SQL 查询（禁止多语句）")


def _extract_cte_names(tokens: list[_Token]) -> set[str]:
    """收集 WITH 子句 CTE 名称（<name> AS (...)），FROM 引用 CTE 时放行。"""
    names: set[str] = set()
    for idx, tok in enumerate(tokens):
        if (
            tok.word is not None
            and idx + 1 < len(tokens)
            and tokens[idx + 1].word == "AS"
        ):
            names.add(tok.word)
    return names


def _extract_table_refs(tokens: list[_Token]) -> list[tuple[str | None, str]]:
    """提取 FROM/JOIN 之后的表引用：(schema, table)。

    - 支持逗号分隔表列表与别名（ai_rooms r / ai_rooms AS r）；
    - '(' 开头视为子查询/函数（内部 FROM 由同一扫描独立覆盖，不误判别名）；
    - LATERAL 子查询不会被误判为表；generate_series(...) 等函数调用跳过。
    """
    refs: list[tuple[str | None, str]] = []
    for idx, tok in enumerate(tokens):
        if tok.word not in _TABLE_PREFIX_KEYWORDS:
            continue
        j = idx + 1
        if j >= len(tokens):
            break
        if tokens[j].text == "(":
            continue  # 子查询/函数组：内部 FROM 由同一扫描覆盖
        while j < len(tokens):
            t = tokens[j]
            if t.word is None:
                break
            if j + 1 < len(tokens) and tokens[j + 1].text == "(":
                break  # 函数调用（set-returning function 等，只读）
            if t.word in _RESERVED_AFTER_TABLE:
                break
            schema = None
            table = t.word
            if j + 1 < len(tokens) and tokens[j + 1].text == ".":
                schema = table
                if j + 2 >= len(tokens) or tokens[j + 2].word is None:
                    break
                table = tokens[j + 2].word
                j += 2
            refs.append((schema, table))
            j += 1
            # 可选别名（如 ai_rooms r / ai_rooms AS r）
            if (
                j < len(tokens)
                and tokens[j].word is not None
                and tokens[j].word not in _RESERVED_AFTER_TABLE
                and tokens[j].text != ","
            ):
                j += 1
            # 逗号分隔的下一个表
            if j < len(tokens) and tokens[j].text == ",":
                j += 1
                continue
            break
    return refs


def _words_with_depth(tokens: list[_Token]) -> list[tuple[str, int]]:
    """带括号深度的关键字/标识符序列（深度 0 = 顶层，用于 WITH...SELECT 检查）。"""
    result: list[tuple[str, int]] = []
    depth = 0
    for tok in tokens:
        if tok.text == "(":
            depth += 1
        elif tok.text == ")":
            depth = max(0, depth - 1)
        elif tok.word is not None:
            result.append((tok.word, depth))
    return result


def validate_sql(sql: str, allowed_tables: set[str]) -> str:
    """校验 AI SQL。

    - 通过：返回清理后的 SQL（去除结尾分号），可交给只读执行器。
    - 拒绝：抛 SqlValidationError（不得执行）。
    """
    if not sql or not sql.strip():
        raise SqlValidationError("SQL 为空")
    if len(sql) > SQL_MAX_LENGTH:
        raise SqlValidationError(f"SQL 过长（最大 {SQL_MAX_LENGTH} 字符）")

    tokens = tokenize(sql)
    statements = _split_statements(tokens)
    stmt = statements[0]
    if not stmt:
        raise SqlValidationError("SQL 为空")
    cte_names = _extract_cte_names(stmt)
    words_depth = _words_with_depth(stmt)
    words = [w for w, _ in words_depth]

    # 写/DDL/DCL/管理/参数关键字与敏感标识符全局拒绝（含数据修改型 CTE；
    # 敏感标识符按包含匹配，覆盖 guest_phone / password_hash 等复合列名）
    for word in words:
        if word in FORBIDDEN_KEYWORDS:
            raise SqlValidationError(f"禁止的关键字：{word}（AI 数据库访问为只读）")
        if any(fid in word for fid in FORBIDDEN_IDENTIFIERS):
            raise SqlValidationError(f"禁止访问的字段：{word}（涉及敏感个人信息或凭据）")

    first = words[0]
    if first not in ("SELECT", "WITH"):
        raise SqlValidationError(f"只允许 SELECT 查询，收到：{first}")

    if first == "WITH":
        # WITH 必须包含顶层（深度 0）SELECT 主查询；仅 CTE 内部的 SELECT 不满足
        if not any(word == "SELECT" and depth == 0 for word, depth in words_depth):
            raise SqlValidationError("WITH 查询必须包含顶层 SELECT 主查询")

    for schema, table in _extract_table_refs(stmt):
        if schema is not None and schema != "PUBLIC":
            raise SqlValidationError(f"只允许 public schema，收到：{schema}.{table}")
        if table not in allowed_tables and table not in cte_names:
            raise SqlValidationError(
                f"无权限访问表/视图：{table}（AI 只能访问当前用户权限范围内的数据）"
            )

    # 清理：去掉结尾分号与结尾空白（分号已在切分时剥离，这里仅返回原语句）
    return sql.strip()


def allowed_tables_for(permissions: set[str]) -> set[str]:
    """按当前用户权限域返回可查询的表/视图集合（Sprint 9 §24 SQL Domain Access）。

    operations 域：房间/预订(无金额与 Guest 关联)/在住/保洁/维修/员工（有限字段）
    business 域：库存*/采购*/供应商（有限字段）
    两个域都持有则取并集；Guest PII（guests 表）永不在任何域内。
    """
    from app.services.ai_tools import (  # noqa: F401  # 延迟导入避免循环
        BUSINESS_DOMAIN_TABLES,
        OPERATIONS_DOMAIN_TABLES,
    )

    tables: set[str] = set()
    if "analytics:operations_read" in permissions:
        tables |= OPERATIONS_DOMAIN_TABLES
    if "analytics:business_read" in permissions:
        tables |= BUSINESS_DOMAIN_TABLES
    return tables
