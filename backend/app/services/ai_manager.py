"""AI Manager Service（Sprint 9 §19/§20/§21）。

一次用户问题：
    DeepSeek -> tool call -> tool result -> DeepSeek -> (maybe another tool) -> final answer
- max tool rounds（settings.ai_max_tool_rounds，默认 5）：超过上限返回安全错误
  AI_TOOL_ROUNDS_EXCEEDED，防止无限 Tool Loop。
- 会话上下文：最近 N 条消息（settings.ai_context_messages，默认 10）；不做
  long-term memory / vector DB / RAG / summarizer（§20 明确不做）。
- 持久化：ai_conversations / ai_messages（user/assistant 消息；tool 消息与
  完整 SQL 结果不持久化）；只保存 user_id / role / content / 时间戳 /
  provider·model / token usage（§21/§36）。
- API Key 只存在 Server Side（ai_settings 密文）；不进入日志/响应/上下文。
"""

from __future__ import annotations

import json
import logging

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.core import ai_crypto
from app.core.ai_schema_context import SCHEMA_CONTEXT
from app.core.audit import write_audit_log
from app.models import AIConversation, AIMessage, AISetting, User
from app.services.ai_tools import TOOL_DEFINITIONS
from app.services.deepseek import (
    AIError,
    AI_NOT_CONFIGURED,
    AI_RESPONSE_INVALID,
    AI_TOOL_ROUNDS_EXCEEDED,
    DeepSeekClient,
)

logger = logging.getLogger("stayops.ai.manager")

SYSTEM_PROMPT = f"""You are StayOps AI Manager（StayOps AI 店长）.

You answer questions about the StayOps property using real StayOps data.

Rules:
- Use get_analytics for established business metrics (occupancy, ADR, RevPAR,
  cancellation, no-show, ALOS, forecast, housekeeping, maintenance, room moves,
  contracted room value, inventory, procurement).
- Use query_stayops_database for ad-hoc operational questions (SELECT only).
- Do not invent data. If data is unavailable, say so clearly.
- Never claim to have modified StayOps. You have read-only access.
- Do not expose internal credentials or sensitive personal data.
- Distinguish facts (from data) from suggestions clearly.
- 中文用户默认用中文回答。

{SCHEMA_CONTEXT}
"""

USER_MESSAGE_MAX_LEN = 4000


def default_client_factory(api_key: str, model: str, base_url: str, timeout_seconds: int) -> DeepSeekClient:
    return DeepSeekClient(
        api_key=api_key,
        base_url=base_url,
        model=model,
        timeout_seconds=timeout_seconds,
    )


class AIManagerService:
    """AI 店长服务：配置读取 + 会话持久化 + 工具循环。"""

    def __init__(self, db: Session, *, client_factory=default_client_factory):
        self.db = db
        self.client_factory = client_factory

    # ------------------------------------------------------------------
    # 配置
    # ------------------------------------------------------------------

    def get_or_create_setting(self) -> AISetting:
        setting = self.db.get(AISetting, 1)
        if setting is None:
            setting = AISetting(id=1, provider="deepseek")
            self.db.add(setting)
            self.db.flush()
        return setting

    def get_stored_key(self) -> str | None:
        """解密后的 API Key；未配置或无法解密 -> None（按未配置处理）。"""
        setting = self.db.get(AISetting, 1)
        if setting is None or not setting.api_key_encrypted:
            return None
        try:
            return ai_crypto.decrypt_api_key(setting.api_key_encrypted)
        except ValueError:
            logger.warning("ai manager: stored API key cannot be decrypted (key mismatch)")
            return None

    def _build_client(self, api_key: str | None = None) -> DeepSeekClient:
        setting = self.get_or_create_setting()
        key = api_key if api_key is not None else self.get_stored_key()
        if not key:
            raise AIError(AI_NOT_CONFIGURED, "尚未配置 DeepSeek API", http_status=409)
        model = setting.model or settings.deepseek_default_model
        return self.client_factory(
            api_key=key,
            model=model,
            base_url=settings.deepseek_api_base_url,
            timeout_seconds=settings.deepseek_request_timeout_seconds,
        )

    # ------------------------------------------------------------------
    # 会话
    # ------------------------------------------------------------------

    def _get_conversation(self, user: User, conversation_id: int) -> AIConversation:
        conv = self.db.get(AIConversation, conversation_id)
        if conv is None or conv.user_id != user.id:
            raise HTTPException(status_code=404, detail="对话不存在")
        return conv

    def _create_conversation(self, user: User, title: str | None) -> AIConversation:
        conv = AIConversation(user_id=user.id, title=title)
        self.db.add(conv)
        self.db.flush()
        return conv

    def _context_messages(self, conversation_id: int) -> list[dict]:
        """最近 N 条已持久化消息（user/assistant），按时间正序。"""
        rows = self.db.scalars(
            select(AIMessage)
            .where(AIMessage.conversation_id == conversation_id)
            .order_by(AIMessage.id.desc())
            .limit(settings.ai_context_messages)
        ).all()
        rows.reverse()
        return [{"role": m.role, "content": m.content} for m in rows]

    def _save_message(
        self,
        conversation_id: int,
        role: str,
        content: str,
        *,
        model: str | None = None,
        usage: dict | None = None,
    ) -> AIMessage:
        msg = AIMessage(
            conversation_id=conversation_id,
            role=role,
            content=content,
            model=model,
            provider="deepseek" if model else None,
            usage_json=usage,
        )
        self.db.add(msg)
        self.db.flush()
        return msg

    # ------------------------------------------------------------------
    # Chat
    # ------------------------------------------------------------------

    def chat(
        self,
        user: User,
        permissions: set[str],
        message: str,
        conversation_id: int | None = None,
        request=None,
    ) -> dict:
        message = message.strip()
        if not message:
            raise HTTPException(status_code=422, detail="消息不能为空")
        if len(message) > USER_MESSAGE_MAX_LEN:
            raise HTTPException(
                status_code=422,
                detail=f"消息过长（最大 {USER_MESSAGE_MAX_LEN} 字符）",
            )

        if conversation_id is not None:
            conv = self._get_conversation(user, conversation_id)
        else:
            conv = self._create_conversation(user, title=message[:50])
        conversation_id = conv.id

        self._save_message(conversation_id, "user", message)
        messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
        messages.extend(self._context_messages(conversation_id))

        usage_total: dict = {}
        tool_rounds = 0
        answer = ""
        model_name = None

        while True:
            client = self._build_client()
            resp = client.chat(messages, tools=TOOL_DEFINITIONS)
            if resp.usage:
                for key, value in resp.usage.items():
                    usage_total[key] = usage_total.get(key, 0) + (value or 0)
            model_name = resp.model

            if resp.tool_calls:
                tool_rounds += 1
                if tool_rounds > settings.ai_max_tool_rounds:
                    raise AIError(
                        AI_TOOL_ROUNDS_EXCEEDED,
                        f"工具调用超过上限（{settings.ai_max_tool_rounds} 轮），已安全终止",
                        http_status=409,
                    )
                for tool_call in resp.tool_calls:
                    name = tool_call.get("name", "")
                    if name not in ("get_analytics", "query_stayops_database"):
                        result = {
                            "error": "AI_UNKNOWN_TOOL",
                            "message": f"未知工具：{name}",
                        }
                    else:
                        result = run_ai_tool(
                            self.db, permissions, name, tool_call.get("arguments")
                        )
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.get("id") or f"call_{tool_rounds}",
                            "content": json.dumps(result, ensure_ascii=False),
                        }
                    )
                continue

            answer = (resp.content or "").strip()
            if not answer:
                raise AIError(AI_RESPONSE_INVALID, "DeepSeek 返回了空回答")
            break

        self._save_message(
            conversation_id,
            "assistant",
            answer,
            model=model_name,
            usage=usage_total or None,
        )
        write_audit_log(
            self.db,
            user,
            "ai_manager.chat",
            resource_type="ai_conversation",
            resource_id=conversation_id,
            details={
                "message_chars": len(message),
                "tool_rounds": tool_rounds,
                "model": model_name,
            },
            request=request,
        )
        self.db.commit()
        return {
            "conversation_id": conversation_id,
            "answer": answer,
            "model": model_name,
            "usage": usage_total or None,
        }

    # ------------------------------------------------------------------
    # Test Connection（§26/§28/§34）
    # ------------------------------------------------------------------

    def test_connection(self, api_key: str | None = None) -> dict:
        client = self._build_client(api_key=api_key)
        result = client.test_connection()
        return result


def run_ai_tool(db: Session, permissions: set[str], name: str, arguments) -> dict:
    """工具分发（服务层薄包装，逻辑集中在 app/services/ai_tools.py）。"""
    from app.services.ai_tools import run_get_analytics, run_query_database

    if name == "get_analytics":
        return run_get_analytics(db, permissions, arguments)
    if name == "query_stayops_database":
        return run_query_database(db, permissions, arguments)
    return {"error": "AI_UNKNOWN_TOOL", "message": f"未知工具：{name}"}
