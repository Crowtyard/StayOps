"""AI Settings 路由（Sprint 9 §26/§28/§40，统一前缀 /api/v1/settings/ai）。

- 权限：ai_manager:manage（SUPER_ADMIN / MANAGER，seed 幂等）
- GET    返回 configured + key_masked（sk-****abcd），绝不返回完整 Key（§5）
- PUT    保存/更新 API Key（Fernet 加密落库）与模型；strict schema
- DELETE /key 删除 API Key
- POST   /test 连接测试（可携带 api_key 只测不存；未知模型由 Provider 错误暴露）
- 审计记录配置变更摘要（不记录 Key 本身）
"""

from fastapi import APIRouter, Depends, Request

from app.api.common import ai_error_http
from app.api.deps import get_ai_service, require_permissions
from app.core import ai_crypto
from app.core.audit import write_audit_log
from app.database import get_db
from app.models import AISetting
from app.schemas.ai import AISettingsOut, AISettingsUpdate, AITestIn, AITestOut
from app.services.ai_manager import AIManagerService
from app.services.deepseek import AIError

router = APIRouter(prefix="/settings/ai", tags=["settings-ai"])

MANAGE = require_permissions("ai_manager:manage")


def _settings_out(db) -> AISettingsOut:
    setting = db.get(AISetting, 1)
    if setting is None:
        return AISettingsOut(provider="deepseek", configured=False, model=None)
    key = None
    if setting.api_key_encrypted:
        try:
            key = ai_crypto.decrypt_api_key(setting.api_key_encrypted)
        except ValueError:
            key = None
    return AISettingsOut(
        provider=setting.provider,
        configured=key is not None,
        key_masked=ai_crypto.mask_api_key(key),
        model=setting.model,
    )


@router.get("", response_model=AISettingsOut, summary="获取 AI 设置状态（掩码 Key）")
def get_ai_settings(
    db=Depends(get_db),
    _user=Depends(MANAGE),
):
    return _settings_out(db)


@router.put("", response_model=AISettingsOut, summary="保存/更新 AI 配置")
def update_ai_settings(
    payload: AISettingsUpdate,
    db=Depends(get_db),
    user=Depends(MANAGE),
    request: Request = None,
    ai_service: AIManagerService = Depends(get_ai_service),
):
    setting = ai_service.get_or_create_setting()
    key_updated = payload.api_key is not None
    if key_updated:
        setting.api_key_encrypted = ai_crypto.encrypt_api_key(payload.api_key.strip())
    if payload.model is not None:
        setting.model = payload.model.strip() or None
    setting.updated_by_user_id = user.id
    write_audit_log(
        db,
        user,
        "ai_settings.update",
        resource_type="ai_settings",
        resource_id=1,
        details={
            "key_updated": key_updated,
            "model_updated": payload.model is not None,
        },
        request=request,
    )
    db.commit()
    return _settings_out(db)


@router.delete("/key", response_model=AISettingsOut, summary="删除 API Key")
def delete_ai_key(
    db=Depends(get_db),
    user=Depends(MANAGE),
    request: Request = None,
    ai_service: AIManagerService = Depends(get_ai_service),
):
    setting = ai_service.get_or_create_setting()
    setting.api_key_encrypted = None
    setting.updated_by_user_id = user.id
    write_audit_log(
        db,
        user,
        "ai_settings.delete_key",
        resource_type="ai_settings",
        resource_id=1,
        details={},
        request=request,
    )
    db.commit()
    return _settings_out(db)


@router.post("/test", response_model=AITestOut, summary="DeepSeek 连接测试")
def test_ai_connection(
    payload: AITestIn | None = None,
    db=Depends(get_db),
    user=Depends(MANAGE),
    request: Request = None,
    ai_service: AIManagerService = Depends(get_ai_service),
):
    if payload is None:
        payload = AITestIn()
    try:
        result = ai_service.test_connection(api_key=payload.api_key)
    except AIError as exc:
        write_audit_log(
            db,
            user,
            "ai_settings.test",
            resource_type="ai_settings",
            resource_id=1,
            details={"ok": False, "code": exc.code},
            request=request,
        )
        db.commit()
        raise ai_error_http(exc)
    write_audit_log(
        db,
        user,
        "ai_settings.test",
        resource_type="ai_settings",
        resource_id=1,
        details={"ok": True, "model": result.get("model")},
        request=request,
    )
    db.commit()
    return result
