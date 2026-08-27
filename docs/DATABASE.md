# StayOps 数据库

> Sprint 1 范围：`users`、`roles`、`permissions`、`user_roles`、`room_types`、`rooms`、`audit_logs`（另含关联表 `role_permissions`）。
> Sprint 2（S2-T1）新增：`guests`、`reservations`、`stays`（另含 PG 枚举 `reservation_status` / `reservation_source` / `stay_status`、Sequence `reservation_no_seq` / `stay_no_seq`、排他约束 `ex_reservations_room_daterange`）。
> Sprint 3 新增：`housekeeping_tasks`（另含 PG 枚举 `hk_task_status` / `hk_task_source` / `hk_task_priority`、Sequence `housekeeping_task_no_seq`、部分唯一索引 `uq_housekeeping_tasks_active_room`）。

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

## Booking 域表结构（Sprint 2 · S2-T1，Migration `16debb5c57f8`）

| 表 | 关键字段 | 说明 |
|---|---|---|
| guests | id, name, phone, email, notes, created_at, updated_at | Guest = PII，由 `guest:read` 门控；**不存**身份证号/人脸/公安登记数据 |
| reservations | id, reservation_no(unique), guest_id(FK→guests RESTRICT), room_id(FK→rooms RESTRICT), room_type_id(FK→room_types RESTRICT), check_in_date, check_out_date, status(枚举), source(枚举), external_reference, agreed_total_amount(Numeric(10,2)), currency, notes, created_by/updated_by(FK→users SET NULL), created_at, updated_at | Reservation = 未来住宿计划；日期区间 `[check_in_date, check_out_date)` |
| stays | id, stay_no(unique), reservation_id(FK→reservations RESTRICT, **unique**), room_id(FK→rooms RESTRICT), status(枚举), actual_check_in_at(timestamptz), planned_check_out_date, actual_check_out_at(timestamptz), created_by/updated_by(FK→users SET NULL), created_at, updated_at | Stay = 实际入住事实；一个 Reservation 至多一个 Stay |

## Housekeeping 域表结构（Sprint 3，Migration `77ec5f0c543e`）

| 表 | 关键字段 | 说明 |
|---|---|---|
| housekeeping_tasks | id, task_no(unique), room_id(FK→rooms RESTRICT), status(枚举), priority(枚举), source(枚举), assigned_to_user_id(FK→users SET NULL), notes, started_at(timestamptz), submitted_for_inspection_at(timestamptz), completed_at(timestamptz), cancelled_at(timestamptz), created_by/updated_by(FK→users SET NULL), created_at, updated_at | Housekeeping Task = 房间翻房任务；**不关联 Guest / Reservation（无 PII）** |

### Housekeeping 域 PG 枚举

```text
hk_task_status:   PENDING / IN_PROGRESS / INSPECTION / REWORK / COMPLETED / CANCELLED
hk_task_source:   CHECKOUT / MANUAL
hk_task_priority: NORMAL / URGENT
```

### 业务单号 Sequence

- `housekeeping_task_no_seq`：应用层 `nextval` 原子取号，格式 `HKT{YYYYMMDD}-{NNNN}`（日期 = Property Business Date，Asia/Shanghai）。
- `task_no` 有 UNIQUE 约束兜底。禁止 SELECT MAX+1。

### Active Task 数据库级唯一（部分唯一索引）

```sql
CREATE UNIQUE INDEX uq_housekeeping_tasks_active_room
ON housekeeping_tasks (room_id)
WHERE status IN ('PENDING', 'IN_PROGRESS', 'INSPECTION', 'REWORK');
```

- 一个 Room 同时至多一个进行中保洁任务；COMPLETED / CANCELLED 不占用名额。
- 并发重复创建由数据库最终仲裁（唯一冲突 23505 → 应用层映射 409）；应用层预检仅为快速路径。
- Checkout 自动创建任务在同一退房事务内（失败整体回滚）。

### 主要索引

- `housekeeping_tasks`：status / room_id / assigned_to_user_id / priority / source（另：部分唯一索引服务 Active Task 唯一）

### Booking 域 PG 枚举

```text
reservation_status:  CONFIRMED / CANCELLED / NO_SHOW / CHECKED_IN / COMPLETED
reservation_source:  DIRECT / PHONE / WECHAT / WALK_IN / OTA / CORPORATE / OTHER
stay_status:         ACTIVE / CHECKED_OUT
```

### 业务单号 Sequence（REV-04）

- `reservation_no_seq` / `stay_no_seq`：应用层 `nextval` 原子取号，格式化 `RSV{YYYYMMDD}-{NNNN}` / `STY{YYYYMMDD}-{NNNN}`（日期 = Property Business Date，Asia/Shanghai）。
- `reservation_no` / `stay_no` 均有 UNIQUE 约束兜底。禁止 SELECT MAX+1。

### Double Booking 数据库级排他约束（REV-01）

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- room_id 相等操作符的 GiST opclass

ALTER TABLE reservations
ADD CONSTRAINT ex_reservations_room_daterange
EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in_date, check_out_date, '[)') WITH &&
) WHERE (status NOT IN ('CANCELLED', 'NO_SHOW', 'COMPLETED'));
```

- 部分约束：只阻塞仍占用日期区间的 `CONFIRMED` / `CHECKED_IN`；`CANCELLED` / `NO_SHOW` / `COMPLETED` 不再阻塞（提前退房释放剩余日期）。
- 约束冲突（pgcode `23P01`）由应用层映射为 409，不泄漏 500。

### 主要索引

- `reservations`：status / guest_id / room_id / room_type_id / check_in_date / check_out_date（另：排他约束的 GiST 索引服务日期重叠查询）
- `stays`：status / room_id / planned_check_out_date
- `guests`：phone

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
- 种子数据（权限/角色/admin/28 房间/6 房型）由 `python -m app.seed` 幂等写入；Sprint 2 新增 9 个 Booking 权限码（共 26 个），Sprint 3 新增 5 个 Housekeeping 权限码（共 31 个），seed 幂等收敛不变
