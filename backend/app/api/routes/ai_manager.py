"""AI Manager 路由（Sprint 9 §25，统一前缀 /api/v1/ai-manager）。

- POST /chat：发送消息 -> {conversation_id, answer, model, usage?}。
  Alpha.9 不做 Streaming（普通 request/response 足够，§25）。
- GET /conversations/{id}/messages：历史消息（页面刷新后保留聊天，§21）。
- 权限：ai_manager:use；AI 可见数据继承当前用户 analytics 域权限（§22/§23），
  由服务层工具执行（get_analytics / query_stayops_database）。
- Provider 失败只影响本路由：AIError -> 清晰业务码（AI_*），绝不 generic 500。
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select

from app.api.common import ai_error_http
from app.api.deps import get_ai_service, get_permission_codes, require_permissions
from app.database import get_db
from app.models import AIConversation, AIMessage
from app.schemas.ai import (
    AIChatOut,
    AIChatRequest,
    AIMessagesOut,
)
from app.services.ai_manager import AIManagerService
from app.services.deepseek import AIError

router = APIRouter(prefix="/ai-manager", tags=["ai-manager"])

USE = require_permissions("ai_manager:use")


@router.post("/chat", response_model=AIChatOut, summary="发送 AI 店长消息")
def chat(
    payload: AIChatRequest,
    db=Depends(get_db),
    user=Depends(USE),
    request: Request = None,
    ai_service: AIManagerService = Depends(get_ai_service),
):
    permissions = get_permission_codes(db, user)
    try:
        result = ai_service.chat(
            user,
            permissions,
            payload.message,
            conversation_id=payload.conversation_id,
            request=request,
        )
    except AIError as exc:
        raise ai_error_http(exc)
    return result


@router.get(
    "/conversations/{conversation_id}/messages",
    response_model=AIMessagesOut,
    summary="对话历史消息（仅本人对话）",
)
def conversation_messages(
    conversation_id: int,
    db=Depends(get_db),
    user=Depends(USE),
):
    conv = db.get(AIConversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(status_code=404, detail="对话不存在")
    rows = db.scalars(
        select(AIMessage)
        .where(
            AIMessage.conversation_id == conversation_id,
            AIMessage.role.in_(("user", "assistant")),
        )
        .order_by(AIMessage.id)
    ).all()
    return {"items": rows}
