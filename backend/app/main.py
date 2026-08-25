"""FastAPI 应用入口。

业务 API 统一挂载在 /api/v1 前缀下；/health 为非业务存活探针。
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.config import settings

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
)

# 开发环境 CORS：允许本地 Next.js 前端（Sprint 1 前端联调使用）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.api_v1_prefix)


@app.get("/health", tags=["health"])
def health() -> dict[str, str]:
    """存活探针（非业务路由）。"""
    return {"status": "ok", "app": settings.app_name}
