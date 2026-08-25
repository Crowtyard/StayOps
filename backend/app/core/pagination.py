"""统一分页工具。

约定：?page=1&page_size=20，返回 {items, total, page, page_size}；
page_size 上限 100（由路由层 Query 参数约束，此处仅做分页计算）。
"""

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100


def paginate(db: Session, stmt: Select, page: int, page_size: int) -> dict:
    """对任意 select 语句分页，返回 {items,total,page,page_size}。

    total 通过子查询 count 计算（复用同一过滤条件）；items 为 ORM 对象列表。
    """
    total = (
        db.scalar(
            select(func.count()).select_from(stmt.order_by(None).subquery())
        )
        or 0
    )
    items = db.scalars(
        stmt.offset((page - 1) * page_size).limit(page_size)
    ).all()
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
    }
