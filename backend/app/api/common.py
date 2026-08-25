"""API 通用工具：统一提交与 409 冲突处理。"""

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session


def commit_or_conflict(db: Session, conflict_message: str) -> None:
    """提交事务；唯一约束/外键冲突转为 409（避免向客户端泄露数据库错误）。"""
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=conflict_message
        )
