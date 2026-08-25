# StayOps 数据库

> Sprint 1 范围：`users`、`roles`、`permissions`、`user_roles`、`room_types`、`rooms`、`audit_logs`（另含关联表 `role_permissions`）。

## 表结构（Sprint 1）

| 表 | 关键字段 | 说明 |
|---|---|---|
| users | id, username(unique), password_hash(bcrypt), display_name, email, phone, is_active | 密码只存哈希 |
| roles | id, name(unique), description | |
| permissions | id, code(unique), name, description | 17 个权限码（Sprint 1） |
| user_roles | user_id, role_id | 复合主键，级联删除 |
| role_permissions | role_id, permission_id | 复合主键，级联删除 |
| room_types | id, name(unique), base_price(Numeric), capacity, description | |
| rooms | id, room_number(unique), room_type_id(FK), floor, **occupancy_status**, **cleaning_status**, notes | 房态双维度（见下） |
| audit_logs | id, user_id(FK nullable, SET NULL), action, resource_type, resource_id, details(JSONB), ip | 后端业务层自动写入 |

## 房态模型（双维度，决策见 DECISIONS.md）

房态拆为两个独立维度，互不约束，可自由组合（例如 `reserved + dirty` = 已预订但待清扫）：

```text
occupancy_status（占用状态，PG 枚举 occupancy_status）：
  available / reserved / occupied / blocked / out_of_service

cleaning_status（清洁状态，PG 枚举 cleaning_status）：
  clean / dirty / cleaning / inspection / rework
```

状态机合法转换见 `backend/app/core/state_machine.py`，由 API 层强制（非法转换 409）。

## 约定

- PostgreSQL 16，通过 Docker Compose 提供开发实例（`stayops` 库；pytest 用独立 `stayops_test` 库）
- Schema 修改必须使用 Alembic Migration（禁止直接改表）
- 凭据不硬编码进 Git，通过 `.env` 加载
- 种子数据（权限/角色/admin/28 房间/6 房型）由 `python -m app.seed` 幂等写入
