"""权限路由：列表（role:read）。"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import require_permissions
from app.core.pagination import paginate
from app.database import get_db
from app.models import Permission, User
from app.schemas.common import Page
from app.schemas.role import PermissionOut

router = APIRouter(prefix="/permissions", tags=["permissions"])


@router.get("", response_model=Page[PermissionOut])
def list_permissions(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    _: User = Depends(require_permissions("role:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(Permission).order_by(Permission.id)
    result = paginate(db, stmt, page, page_size)
    result["items"] = [PermissionOut.model_validate(p) for p in result["items"]]
    return result
