# StayOps 架构决策记录（ADR）

> 重大架构决策记录于此。每条记录：背景、决策、后果、日期。

## 2026-08-25 — 环境准备

- 技术栈选定：Next.js + TypeScript / FastAPI + Python / PostgreSQL / Docker Compose
- 开发环境：DeepSeek Harness（DSH）web profile，插件：dshmarket、dsh-better-sidebar、dsh-turn-rewind、dsh-context、dsh-permission-rules
- 开发模型：DeepSeek V4-Pro（见 ENVIRONMENT_CHECK.md）

## 2026-08-25 — Sprint 1 第一阶段：后端骨架

1. **新增第 8 张表 `role_permissions`**：任务书列出 7 张表（users/roles/permissions/user_roles/room_types/rooms/audit_logs），但未定义「角色-权限映射」的存储位置；RBAC 映射必须持久化，故增加 `role_permissions(role_id, permission_id)` 复合主键关联表（外键 CASCADE）。后续「7 张表」的提法应理解为最小集合。
2. **权限粒度**：在任务书要求的「5 模块 × read/write/delete」15 个权限之外，增加 `room:status_cleaning`、`room:status_maintenance` 两个细粒度权限，共 17 个。理由：HOUSEKEEPING/MAINTENANCE 角色只允许变更单一房态；若复用 `room:write`（任务书 API 表约定房态变更需 room:write），将导致这两个角色获得全部房间编辑权，违反最小权限。第二阶段房态变更接口的鉴权逻辑为：持有 `room:write` 或对应的 `room:status_<new_status>` 之一即可。
3. **角色权限映射的种子同步策略**：seed 对 6 个种子角色做「精确同步」（删除多余映射、补齐缺失映射），SUPER_ADMIN 动态 = 全部权限；重复执行收敛到一致状态。
4. **`rooms.status` 使用 PostgreSQL 原生枚举** `room_status`（5 个值），初始 migration 随建表隐式创建类型，downgrade 显式 DROP TYPE。
5. **bcrypt 固定 4.0.1**：passlib 1.7.4 与 bcrypt≥4.1 存在 `__about__` 兼容性问题，requirements.txt 锁定 bcrypt==4.0.1。
6. **admin 种子密码不回写**：admin 已存在时 seed 不重置密码（尊重「首次登录后可改密」），仅确保启用与 SUPER_ADMIN 角色。
7. **配置加载**：pydantic-settings 按 (backend/.env, 仓库根 .env) 顺序查找；Alembic 连接串由 `app.config.settings` 统一提供，不在 alembic.ini 中写真实凭据。
