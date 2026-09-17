"""API v1 聚合路由（统一前缀 /api/v1，见 main.py 挂载）。"""

from fastapi import APIRouter

from app.api.routes import (
    ai_manager,
    analytics,
    audit_logs,
    auth,
    availability,
    channels,
    dashboard,
    guests,
    housekeeping,
    inventory,
    maintenance,
    permissions,
    procurement,
    reservations,
    roles,
    room_types,
    rooms,
    settings_ai,
    stays,
    users,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(roles.router)
api_router.include_router(permissions.router)
api_router.include_router(room_types.router)
api_router.include_router(rooms.router)
api_router.include_router(channels.router)
api_router.include_router(dashboard.router)
api_router.include_router(audit_logs.router)
api_router.include_router(guests.router)
api_router.include_router(availability.router)
api_router.include_router(reservations.router)
api_router.include_router(stays.router)
api_router.include_router(housekeeping.router)
api_router.include_router(housekeeping.assignees_router)
api_router.include_router(maintenance.router)
api_router.include_router(maintenance.assignees_router)
api_router.include_router(inventory.router)
api_router.include_router(procurement.router)
api_router.include_router(analytics.router)
api_router.include_router(settings_ai.router)
api_router.include_router(ai_manager.router)
