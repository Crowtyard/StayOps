# StayOps 数据库

> 状态：待 Sprint 1 启动时填充。Sprint 1 预计数据表：
> `users`、`roles`、`permissions`、`user_roles`、`rooms`、`room_types`、`audit_logs`

## 约定

- PostgreSQL，通过 Docker Compose 提供开发实例
- Schema 修改必须使用 Migration（不允许直接改表）
- 凭据不硬编码进 Git，通过 `.env` 加载
