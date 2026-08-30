"""API 通用工具：统一提交与 409 冲突处理。"""

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.services.deepseek import AIError


def commit_or_conflict(db: Session, conflict_message: str) -> None:
    """提交事务；唯一约束/外键冲突转为 409（避免向客户端泄露数据库错误）。"""
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=conflict_message
        )


def ai_error_http(exc: AIError) -> HTTPException:
    """AI 业务错误 -> HTTP 响应（§7：清晰业务错误码，不全部变成 generic 500）。

    错误码前缀 AI_*；http_status 由 AIError 携带（配置/循环类 409，Provider 类 502）。
    """
    return HTTPException(
        status_code=exc.http_status,
        detail=f"{exc.code}: {exc}",
    )
