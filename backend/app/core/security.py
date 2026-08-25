"""密码哈希与 JWT 工具。

- 密码仅存 bcrypt 哈希（与 seed 使用同一 CryptContext）
- JWT：HS256，sub=用户 id，exp=签发时间 + access_token_expire_minutes
- 任何日志/响应不得输出密码、哈希与 Token（见 AGENTS.md 规则 10/11）
"""

from datetime import datetime, timedelta, timezone

from jose import jwt
from jose.exceptions import JWTError
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    """bcrypt 哈希（不返回/不记录明文）。"""
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """校验密码；哈希格式异常时返回 False（不抛异常、不泄露细节）。"""
    try:
        return pwd_context.verify(plain, hashed)
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: int) -> str:
    """签发访问令牌（python-jose 返回 str）。"""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_expire_minutes),
    }
    return jwt.encode(
        payload, settings.secret_key, algorithm=settings.jwt_algorithm
    )


def decode_access_token(token: str) -> int | None:
    """解析令牌返回用户 id；无效/过期返回 None。"""
    try:
        payload = jwt.decode(
            token, settings.secret_key, algorithms=[settings.jwt_algorithm]
        )
    except JWTError:
        return None
    sub = payload.get("sub")
    try:
        return int(sub)
    except (TypeError, ValueError):
        return None
