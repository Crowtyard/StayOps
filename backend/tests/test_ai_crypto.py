# -*- coding: utf-8 -*-
"""AI 密钥安全测试（Sprint 9 §5/§35）：Fernet 加密、掩码、密钥分离。"""

import pytest

from app.core import ai_crypto


def test_encrypt_decrypt_roundtrip():
    plain = "sk-1234567890abcdef"
    encrypted = ai_crypto.encrypt_api_key(plain)
    assert ai_crypto.decrypt_api_key(encrypted) == plain


def test_ciphertext_never_contains_plaintext():
    plain = "sk-super-secret-key-0000"
    encrypted = ai_crypto.encrypt_api_key(plain)
    assert plain not in encrypted
    assert plain not in repr(encrypted)


def test_encrypted_values_differ_between_calls():
    """Fernet 密文每次不同（IV 随机），但都可解密。"""
    plain = "sk-abc123"
    e1 = ai_crypto.encrypt_api_key(plain)
    e2 = ai_crypto.encrypt_api_key(plain)
    assert e1 != e2
    assert ai_crypto.decrypt_api_key(e1) == ai_crypto.decrypt_api_key(e2) == plain


def test_mask_long_key():
    assert ai_crypto.mask_api_key("sk-1234567890abcd") == "sk-****abcd"


def test_mask_short_key():
    assert ai_crypto.mask_api_key("abcd") == "****"


def test_mask_none():
    assert ai_crypto.mask_api_key(None) is None
    assert ai_crypto.mask_api_key("") is None


def test_decrypt_with_wrong_key_raises(monkeypatch):
    plain = "sk-secret"
    encrypted = ai_crypto.encrypt_api_key(plain)
    monkeypatch.setattr(ai_crypto.settings, "ai_api_key_encryption_key", "another-key")
    with pytest.raises(ValueError):
        ai_crypto.decrypt_api_key(encrypted)


def test_corrupted_ciphertext_raises():
    with pytest.raises(ValueError):
        ai_crypto.decrypt_api_key("not-a-valid-fernet-token!!")


def test_settings_key_from_env_not_hardcoded_with_ciphertext():
    """加密密钥来自配置（可经环境变量 AI_ENCRYPTION_KEY 覆盖），与密文分开存储。"""
    assert hasattr(ai_crypto.settings, "ai_api_key_encryption_key")
    # 密文不包含配置密钥本身（密钥与密文分离存储原则）
    encrypted = ai_crypto.encrypt_api_key("sk-x")
    assert ai_crypto.settings.ai_api_key_encryption_key not in encrypted
