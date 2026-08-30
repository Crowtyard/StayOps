"""AI Manager 域 schemas（Sprint 9 §25/§26/§40）。

安全约定：
- 任何响应不返回完整 API Key；GET /settings/ai 只返回 configured 与掩码
  key_masked（sk-****abcd）。
- Chat 响应返回 conversation_id / answer / model / usage（prompt_tokens /
  completion_tokens / total_tokens，§36），不做 Streaming（§25）。
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ---------------------------------------------------------------------------
# Settings（§26/§40）
# ---------------------------------------------------------------------------


class AISettingsOut(BaseModel):
    """AI 设置状态（绝不包含完整 API Key）。"""

    provider: str
    configured: bool
    key_masked: str | None = None
    model: str | None = None


class AISettingsUpdate(BaseModel):
    """保存/更新 AI 配置（strict：未知字段 422；至少提供一个字段）。"""

    model_config = ConfigDict(extra="forbid")

    api_key: str | None = Field(default=None, min_length=8, max_length=300)
    model: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def _at_least_one(self) -> "AISettingsUpdate":
        if self.api_key is None and self.model is None:
            raise ValueError("至少提供 api_key 或 model 之一")
        if self.api_key is not None and not self.api_key.strip():
            raise ValueError("api_key 不能为空")
        return self


class AITestIn(BaseModel):
    """连接测试：可携带 api_key 测试（不保存），否则使用已保存 Key。"""

    model_config = ConfigDict(extra="forbid")

    api_key: str | None = Field(default=None, min_length=8, max_length=300)


class AITestOut(BaseModel):
    ok: bool
    model: str | None = None
    latency_ms: int | None = None
    usage: dict | None = None


# ---------------------------------------------------------------------------
# Chat（§25）
# ---------------------------------------------------------------------------


class AIChatRequest(BaseModel):
    """发送一条用户消息。conversation_id 为空时创建新对话。"""

    model_config = ConfigDict(extra="forbid")

    conversation_id: int | None = None
    message: str = Field(min_length=1, max_length=4000)


class AIChatOut(BaseModel):
    conversation_id: int
    answer: str
    model: str | None = None
    usage: dict | None = None


class AIMessageOut(BaseModel):
    """历史消息（不含工具消息与原始 SQL 结果）。"""

    id: int
    role: str
    content: str
    model: str | None = None
    created_at: datetime


class AIMessagesOut(BaseModel):
    items: list[AIMessageOut]
