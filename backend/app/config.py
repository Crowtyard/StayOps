"""应用配置（pydantic-settings）。

配置来源优先级：环境变量 > .env 文件 > 代码默认值。
.env 文件按 (backend/.env, 仓库根 .env) 顺序查找，未找到的文件自动忽略。
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 应用
    app_name: str = "StayOps API"
    app_version: str = "0.1.0"
    api_v1_prefix: str = "/api/v1"

    # 数据库（默认值与 docker-compose 的开发库一致）
    database_url: str = (
        "postgresql+psycopg2://stayops:change-me@localhost:5432/stayops"
    )

    # 认证（JWT，Sprint 1 第二阶段使用）
    secret_key: str = "dev-secret-key-change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 12 * 60

    # ------------------------------------------------------------------
    # Sprint 9 · AI Manager（DeepSeek AI 店长）
    # ------------------------------------------------------------------
    # API Key 加密密钥（Fernet，后端环境/配置专用，绝不与密文一起存储或进 Git）。
    # 生产必须通过环境变量 AI_ENCRYPTION_KEY 提供；本默认值仅用于本地开发。
    ai_api_key_encryption_key: str = "stayops-dev-ai-encryption-key-change-me"

    # DeepSeek API（Alpha.9 仅 DeepSeek，不建立 Multi-provider Framework）
    deepseek_api_base_url: str = "https://api.deepseek.com"
    deepseek_default_model: str = "deepseek-chat"
    deepseek_request_timeout_seconds: int = 60

    # AI 只读 SQL 执行（双层保护：应用 Validator + PostgreSQL 只读 Role）
    # stayops_ai_reader 角色密码（与迁移/seed 中设置的一致；生产必须环境变量提供）
    ai_reader_database_password: str = "change-me"
    ai_sql_statement_timeout_ms: int = 10000
    ai_sql_max_rows: int = 200          # 默认最多返回行数
    ai_sql_max_rows_hard_limit: int = 500  # 硬上限

    # AI 会话
    ai_max_tool_rounds: int = 5         # 工具循环上限（防无限 Tool Loop）
    ai_context_messages: int = 10       # 最近 N 条消息上下文


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
