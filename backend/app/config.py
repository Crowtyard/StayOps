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


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
