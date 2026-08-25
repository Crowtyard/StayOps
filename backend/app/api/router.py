"""API v1 聚合路由（统一前缀 /api/v1，见 main.py 挂载）。"""

from fastapi import APIRouter

from app.api.routes import (
    audit_logs,
    auth,
    permissions,
    roles,
    room_types,
    rooms,
    users,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(roles.router)
api_router.include_router(permissions.router)
api_router.include_router(room_types.router)
api_router.include_router(rooms.router)
api_router.include_router(audit_logs.router)
