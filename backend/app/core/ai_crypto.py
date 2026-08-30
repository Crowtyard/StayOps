"""AI Manager 密钥安全（Sprint 9）。

规则（Sprint 9 §5 / §35）：
- DeepSeek API Key 只保存在 Server Side；任何响应/日志/审计不返回完整 Key。
- 持久化使用成熟加密库（cryptography 的 Fernet，随 python-jose[cryptography]
  已安装，无新增依赖），禁止自创加密算法。
- 加密密钥来自 Backend environment/config（settings.ai_api_key_encryption_key），
  与密文分开存储；生产必须通过环境变量 AI_ENCRYPTION_KEY 提供。
- 前端/外部只能看到 configured 布尔值或掩码（sk-****abcd）。
"""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

_MASK_PREFIX_LEN = 3  # "sk-"
_MASK_SUFFIX_LEN = 4


def _fernet() -> Fernet:
    """由配置密钥派生 Fernet 密钥（SHA-256 -> base64url，满足 Fernet 32 字节要求）。"""
    digest = hashlib.sha256(settings.ai_api_key_encryption_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_api_key(plain: str) -> str:
    """加密 API Key（Fernet token，UTF-8 字符串）。"""
    return _fernet().encrypt(plain.encode("utf-8")).decode("utf-8")


def decrypt_api_key(encrypted: str) -> str:
    """解密 API Key；密钥不匹配/密文损坏 -> ValueError（调用方按未配置处理）。"""
    try:
        return _fernet().decrypt(encrypted.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise ValueError("API Key 无法解密（加密密钥不匹配或密文损坏）") from exc


def mask_api_key(plain: str | None) -> str | None:
    """掩码：sk-****abcd；空值返回 None。"""
    if not plain:
        return None
    if len(plain) <= _MASK_PREFIX_LEN + _MASK_SUFFIX_LEN:
        return "****"
    return f"{plain[:_MASK_PREFIX_LEN]}****{plain[-_MASK_SUFFIX_LEN:]}"
