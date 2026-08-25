"""FastAPI 应用入口（Sprint 1 第一阶段：仅骨架）。

业务 API 路由（/api/v1/auth、/users、/roles、/room-types、/rooms、/audit-logs）
在 Sprint 1 第二阶段实现，本阶段不包含。
"""

from fastapi import FastAPI

from app.config import settings

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
)


@app.get("/health", tags=["health"])
def health() -> dict[str, str]:
    """存活探针（非业务路由）。"""
    return {"status": "ok", "app": settings.app_name}
