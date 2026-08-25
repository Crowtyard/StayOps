"""通用 schema：统一分页响应 {items,total,page,page_size}。"""

from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    """列表接口统一分页响应。"""

    items: list[T]
    total: int
    page: int
    page_size: int
