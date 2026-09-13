"""add must_change_password to users

Revision ID: b7c1e5a93d24
Revises: f5d3b9e7a2c4
Create Date: 2026-09-13 18:30:00.000000

D2 · Fully Bundled Installer（alpha.9.4）首次安装强制改密：
- users.must_change_password：bootstrap 管理员首次登录后必须先修改初始密码，
  之后才允许访问其它 API（后端强制，见 app/api/deps.get_current_user）。
- 默认 false：既有用户与开发/测试环境行为完全不变；
  只有安装版首次 seed（bootstrap 凭据）创建的管理员会带 true。
- 安全性：初始密码由 Desktop 首次启动生成（随机、DPAPI 保护、只显示一次），
  修改成功后清除该标记，并可销毁 bootstrap 凭据。

升级/降级均不触碰业务数据。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "b7c1e5a93d24"
down_revision: Union[str, Sequence[str], None] = "f5d3b9e7a2c4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "must_change_password",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "must_change_password")
