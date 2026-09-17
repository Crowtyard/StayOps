# StayOps 数据库

> alpha.9.6 新增（Migration `a96b1c4d7e02`，Field Trial Operations Improvements）：
> - `rooms` 增加 `name`（房间显示名称，nullable）与 `is_active`（是否投入经营，
>   NOT NULL default true，`ix_rooms_is_active`）。
>   **未新增任何 room_count 真值字段** —— 房间数量永远是 rooms 记录的计算结果
>   （`GET /rooms/summary` 用 `COUNT(*) FILTER`）。
> - 新表 `channels`（客源渠道主数据）+ PG 枚举 `channel_category`
>   （OTA / DIRECT / OFFLINE / CORPORATE / OTHER）+ 唯一索引
>   `ix_channels_code` / `ix_channels_name`；预置 10 个系统渠道。
> - `reservations` 增加 `source_channel_id`（FK→channels RESTRICT, nullable,
>   `ix_reservations_source_channel_id`）= **唯一渠道业务事实源**；
>   legacy `source` 列保留为**只读历史投影**，迁移按固定映射表全量回填
>   （原值一字不改）。
> - AI 只读视图：新增 `ai_channels`，`ai_rooms` 增加 `name, is_active`，
>   `ai_reservations` 增加 `source_channel_id`（**21 → 22 个 `ai_*` 视图**）。
> - 新增权限码 `channel:read` / `channel:write`（52 → 54），只经 `app/seed.py`
>   幂等收敛，**migration 不写权限表、不授权**。
> - **不自动 downgrade**（仓库政策）；该 revision 本身可逆（downgrade 会 DROP 视图
>   重建为 legacy 定义，legacy `source` 列始终未被修改，原始来源事实不丢失）。

> Sprint 1 范围：`users`、`roles`、`permissions`、`user_roles`、`room_types`、`rooms`、`audit_logs`（另含关联表 `role_permissions`）。
> Sprint 2（S2-T1）新增：`guests`、`reservations`、`stays`（另含 PG 枚举 `reservation_status` / `reservation_source` / `stay_status`、Sequence `reservation_no_seq` / `stay_no_seq`、排他约束 `ex_reservations_room_daterange`）。
> Sprint 3 新增：`housekeeping_tasks`（另含 PG 枚举 `hk_task_status` / `hk_task_source` / `hk_task_priority`、Sequence `housekeeping_task_no_seq`、部分唯一索引 `uq_housekeeping_tasks_active_room`）。
> Sprint 5 新增：`maintenance_work_orders` + `rooms.unavailability_source`（另含 PG 枚举 `mwo_status` / `mwo_category` / `mwo_severity` / `mwo_source` / `unavailability_source`、Sequence `maintenance_work_order_no_seq`、CHECK 约束 `ck_rooms_unavailability_source`、部分索引 `ix_mwo_active_blocking_room`）。
> Sprint 6 新增：`stay_room_assignments`（另含 PG 枚举 `room_move_reason`、CHECK 约束 `ck_stay_room_assignments_interval`、部分唯一索引 `uq_stay_room_assignments_active_stay`、排他约束 `ex_stay_room_assignments_no_overlap`；`hk_task_source` 增加 ROOM_MOVE；Reservation 排他约束调整为 CONFIRMED-only；既有 Stay 历史回填）。
> Sprint 7 新增：Inventory 域（`inventory_items` / `inventory_locations` / `inventory_balances` / `stock_movements` / `stock_issues` / `stock_issue_lines`）与 Procurement 域（`suppliers` / `purchase_requests` / `purchase_request_lines` / `purchase_orders` / `purchase_order_lines` / `goods_receipts` / `goods_receipt_lines`），另含 PG 枚举 `item_category` / `movement_type` / `issue_destination_type` / `purchase_request_status` / `purchase_order_status` 与 5 个业务单号 Sequence。
> Sprint 8 为 Analytics 只读派生层（read-only derived layer）：**不新增任何业务表**（无 daily_statistics / analytics_fact / analytics_warehouse），正式业务表仍是 Source of Truth；除 2 个权限 Seed（`analytics:operations_read` / `analytics:business_read`，50 权限码）外无 Schema Migration（Alembic head 保持 `e3a91f5c8d24`）。指标定义见 [docs/ANALYTICS.md](ANALYTICS.md) 与 `backend/app/core/analytics_metrics.py`。
> Sprint 9 新增 AI Manager 域（Migration `f5d3b9e7a2c4`）：`ai_settings`（DeepSeek 配置单行表，API Key 只存 Fernet 密文）/ `ai_conversations` / `ai_messages` + **21 个 `ai_*` 只读视图**（Guest PII 与敏感字段物理排除）+ 数据库级只读 Role **`stayops_ai_reader`**（仅 SELECT 视图，无任何基表写权限）。另新增 2 个权限 Seed（`ai_manager:use` / `ai_manager:manage`，52 权限码）。

## 表结构（Sprint 1）

| 表 | 关键字段 | 说明 |
|---|---|---|
| users | id, username(unique), password_hash(bcrypt), display_name, email, phone, is_active | 密码只存哈希 |
| roles | id, name(unique), description | |
| permissions | id, code(unique), name, description | 17 个权限码（Sprint 1） |
| user_roles | user_id, role_id | 复合主键，级联删除 |
| role_permissions | role_id, permission_id | 复合主键，级联删除 |
| room_types | id, name(unique), base_price(Numeric), capacity, description | |
| rooms | id, room_number(unique), **name**(nullable), room_type_id(FK), floor, **is_active**(bool, default true), **occupancy_status**, **cleaning_status**, **unavailability_source**(nullable), notes | 房态双维度 + 不可售来源（见下）；**name = 房间显示名称；is_active = 是否投入经营（停用不释放房号、不破坏历史）**；房间数量由 COUNT 计算，无 room_count 列 |
| audit_logs | id, user_id(FK nullable, SET NULL), action, resource_type, resource_id, details(JSONB), ip | 后端业务层自动写入 |

## Booking 域表结构（Sprint 2 · S2-T1，Migration `16debb5c57f8`）

| 表 | 关键字段 | 说明 |
|---|---|---|
| guests | id, name, phone, email, notes, created_at, updated_at | Guest = PII，由 `guest:read` 门控；**不存**身份证号/人脸/公安登记数据 |
| reservations | id, reservation_no(unique), guest_id(FK→guests RESTRICT), room_id(FK→rooms RESTRICT), room_type_id(FK→room_types RESTRICT), check_in_date, check_out_date, status(枚举), source(枚举, **legacy 只读投影**), **source_channel_id**(FK→channels RESTRICT, **唯一来源事实**), external_reference, agreed_total_amount(Numeric(10,2)), currency, notes, created_by/updated_by(FK→users SET NULL), created_at, updated_at | Reservation = 未来住宿计划；日期区间 `[check_in_date, check_out_date)`；**Sprint 6：Check-in 后 room_id 冻结为原分配房** |
| stays | id, stay_no(unique), reservation_id(FK→reservations RESTRICT, **unique**), room_id(FK→rooms RESTRICT), status(枚举), actual_check_in_at(timestamptz), planned_check_out_date, actual_check_out_at(timestamptz), created_by/updated_by(FK→users SET NULL), created_at, updated_at | Stay = 实际入住事实；一个 Reservation 至多一个 Stay；**room_id = 当前实际房间快速指针（Sprint 6）** |

## Channel 域表结构（alpha.9.6 F3，Migration `a96b1c4d7e02`）

| 表 | 关键字段 | 说明 |
|---|---|---|
| channels | id, code(unique, String(50)), name(unique, String(100)), category(枚举 channel_category), enabled(bool), is_system(bool), sort_order(int), created_at, updated_at | **客源渠道主数据**（可扩展，非硬编码 enum）。`code` 稳定不可变（系统渠道 `SYS_*` / 迁移预置 `CUSTOM_OTHER`·`CUSTOM_LEGACY` / 自建渠道后端生成 `CUSTOM_<slug>`）；`name` 全局唯一（**含停用渠道：停用不释放名称**）；`is_system=true` 名称固定且不可删除；`enabled=false` 不可用于新预订但历史预订完整保留 |

`channel_category` 枚举值：`OTA`（OTA 平台）/ `DIRECT`（直销）/ `OFFLINE`（线下）/
`CORPORATE`（协议客户）/ `OTHER`（其他）。

预置系统渠道（顺序 = `sort_order`）：美团(OTA,10) / 携程(OTA,20) / 飞猪(OTA,30) /
直订(DIRECT,40) / 电话(OFFLINE,50) / 微信(OFFLINE,60) / 散客(OFFLINE,70) /
协议客户(CORPORATE,80) / 其他(OTHER,900) / 历史来源(OTHER,990)。

**legacy source → channel 回填映射（migration，逐值固定）**：
`DIRECT→直订`、`PHONE→电话`、`WECHAT→微信`、`WALK_IN→散客`、`OTA→其他`、
`CORPORATE→协议客户`、`OTHER→其他`、NULL/未知→`历史来源`。

## Room Move 域表结构（Sprint 6，Migration `c8e2b7a4d1f3`）

| 表 | 关键字段 | 说明 |
|---|---|---|
| stay_room_assignments | id, stay_id(FK→stays RESTRICT), room_id(FK→rooms RESTRICT), started_at(timestamptz), ended_at(timestamptz, nullable), reason(枚举, nullable), notes, created_by(FK→users SET NULL), created_at | StayRoomAssignment = 实际住宿期间的房间历史；**ended_at = NULL 表示当前 active assignment**；reason 仅 Room Move 时记录（Check-in / backfill = NULL，UI 显示「入住」） |

### Room Move 域 PG 枚举

```text
room_move_reason: MAINTENANCE / GUEST_REQUEST / ROOM_QUALITY /
                  OPERATIONAL / UPGRADE / DOWNGRADE / OTHER
```

### 约束（Sprint 6 §3）

```sql
-- ended_at > started_at（ended_at NULL = active assignment）
CONSTRAINT ck_stay_room_assignments_interval CHECK (
    ended_at IS NULL OR ended_at > started_at
)

-- 每个 Stay 最多一个 active assignment（数据库最终仲裁）
CREATE UNIQUE INDEX uq_stay_room_assignments_active_stay
ON stay_room_assignments (stay_id) WHERE ended_at IS NULL

-- 同一 Stay 的 assignment 区间不重叠（btree_gist + tstzrange 半开区间；
-- [s1,e1) 与 [e1,∞) 紧邻不冲突；ended_at NULL = 无上界）
ALTER TABLE stay_room_assignments
ADD CONSTRAINT ex_stay_room_assignments_no_overlap
EXCLUDE USING gist (
    stay_id WITH =,
    tstzrange(started_at, ended_at, '[)') WITH &&
)
```

### 既有 Stay 历史回填（Sprint 6 §4，确定性）

```text
room_id     = stays.room_id（当前实际房间）
started_at  = stays.actual_check_in_at（canonical check-in 时间）
ended_at    = stays.actual_check_out_at（已退房）；ACTIVE Stay → NULL
reason      = NULL（初始分配，UI 显示「入住」）
created_by  = stays.created_by
created_at  = started_at
```

## Housekeeping 域表结构（Sprint 3，Migration `77ec5f0c543e`）

| 表 | 关键字段 | 说明 |
|---|---|---|
| housekeeping_tasks | id, task_no(unique), room_id(FK→rooms RESTRICT), status(枚举), priority(枚举), source(枚举), assigned_to_user_id(FK→users SET NULL), notes, started_at(timestamptz), submitted_for_inspection_at(timestamptz), completed_at(timestamptz), cancelled_at(timestamptz), created_by/updated_by(FK→users SET NULL), created_at, updated_at | Housekeeping Task = 房间翻房任务；**不关联 Guest / Reservation（无 PII）** |

### Housekeeping 域 PG 枚举

```text
hk_task_status:   PENDING / IN_PROGRESS / INSPECTION / REWORK / COMPLETED / CANCELLED
hk_task_source:   CHECKOUT / MANUAL / ROOM_MOVE（Sprint 6：换房自动保洁任务）
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

## Maintenance 域表结构（Sprint 5，Migration `a7f3e4c1d902`）

| 表 | 关键字段 | 说明 |
|---|---|---|
| maintenance_work_orders | id, work_order_no(unique), room_id(FK→rooms RESTRICT), category(枚举), severity(枚举), status(枚举), source(枚举), blocks_room(bool), title, description, reported_by_user_id(FK→users SET NULL), assigned_to_user_id(FK→users SET NULL), verified_by_user_id(FK→users SET NULL), resolution_notes, verification_notes, started_at(timestamptz), resolved_at(timestamptz), verified_at(timestamptz), completed_at(timestamptz), cancelled_at(timestamptz), created_by/updated_by(FK→users SET NULL), created_at, updated_at | Maintenance Work Order = 维修工单；**不关联 Guest / Reservation / Stay（无 PII）**；同一 Room 允许多张 Active 工单（无 active-per-room 唯一约束） |

### Maintenance 域 PG 枚举

```text
mwo_status:            OPEN / ASSIGNED / IN_PROGRESS / RESOLVED / COMPLETED / CANCELLED
mwo_category:          ELECTRICAL / PLUMBING / HVAC / LOCK / BATHROOM /
                       FURNITURE / APPLIANCE / NETWORK / FINISHING / OTHER
mwo_severity:          LOW / MEDIUM / HIGH / CRITICAL
mwo_source:            MANUAL / FRONT_DESK / HOUSEKEEPING / PRE_OPENING
unavailability_source: MANUAL / MAINTENANCE
```

### 业务单号 Sequence

- `maintenance_work_order_no_seq`：应用层 `nextval` 原子取号，格式 `MWO{YYYYMMDD}-{NNNN}`（日期 = Property Business Date，Asia/Shanghai）。
- `work_order_no` 有 UNIQUE 约束兜底。禁止 SELECT MAX+1。

### rooms.unavailability_source（Sprint 5 §4，Room metadata）

```text
available / reserved / occupied  -> normally NULL
blocked                          -> MANUAL（运营/人工锁房）
out_of_service                   -> MANUAL or MAINTENANCE
```

- 历史数据安全回填：existing blocked / out_of_service → MANUAL；其它 → NULL
  （不允许把既有人工不可售房错误标记成 MAINTENANCE）。
- CHECK 约束 `ck_rooms_unavailability_source`：unavailability_source 与
  occupancy_status 语义一致性数据库级兜底。
- Maintenance 只能解除自己造成的 OOS（source=MAINTENANCE 且 active blocking MWO=0）；
  MANUAL OOS / blocked 永不被 Maintenance 解除。

### Active Blocking 部分索引

```sql
CREATE INDEX ix_mwo_active_blocking_room
ON maintenance_work_orders (room_id)
WHERE blocks_room
  AND status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED');
```

- 服务 Availability / Check-in / Checkout 集成查询；RESOLVED 仍阻断
  （维修完成 ≠ 酒店验收通过）。

### 主要索引

- `maintenance_work_orders`：status / room_id / category / severity /
  assigned_to_user_id / source（另：部分索引服务 Active Blocking 查询）
- `rooms`：unavailability_source

### Booking 域 PG 枚举

```text
reservation_status:  CONFIRMED / CANCELLED / NO_SHOW / CHECKED_IN / COMPLETED
reservation_source:  DIRECT / PHONE / WECHAT / WALK_IN / OTA / CORPORATE / OTHER
stay_status:         ACTIVE / CHECKED_OUT
```

### 业务单号 Sequence（REV-04）

- `reservation_no_seq` / `stay_no_seq`：应用层 `nextval` 原子取号，格式化 `RSV{YYYYMMDD}-{NNNN}` / `STY{YYYYMMDD}-{NNNN}`（日期 = Property Business Date，Asia/Shanghai）。
- `reservation_no` / `stay_no` 均有 UNIQUE 约束兜底。禁止 SELECT MAX+1。

### Double Booking 数据库级排他约束（REV-01，Sprint 6 §6 调整为 CONFIRMED-only）

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- room_id 相等操作符的 GiST opclass

ALTER TABLE reservations
ADD CONSTRAINT ex_reservations_room_daterange
EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in_date, check_out_date, '[)') WITH &&
) WHERE (status = 'CONFIRMED');
```

- Sprint 6 起部分约束只作用于 `CONFIRMED`：CHECKED_IN 后实际住宿房间由
  `Stay.room_id` + `StayRoomAssignment` 表达；Reservation.room_id 在 Check-in
  后冻结为原分配房，不得继续锁原房至原退房日（否则 203→205 后 203 被错误阻塞）。
  `CANCELLED` / `NO_SHOW` / `COMPLETED` 仍不阻塞（提前退房释放剩余日期）。
- Active Stay vs 新 CONFIRMED 预订的并发仲裁由 Room row lock +
  active Stay check + remaining stay interval check 完成（见 DECISIONS Sprint 6）；
  排他约束为 CONFIRMED vs CONFIRMED 的数据库最终保护。
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

## Inventory 域表结构（Sprint 7，Migration `e3a91f5c8d24`）

| 表 | 关键字段 | 说明 |
|---|---|---|
| inventory_items | id, item_code(unique，创建后不可变), name, category(枚举), base_unit(唯一基础单位), specification, minimum_stock(Numeric(12,2)), target_stock, is_consumable, is_active, notes, created_at, updated_at | 库存物资档案；CHECK `minimum_stock >= 0` / `target_stock >= 0` / `target_stock >= minimum_stock`；停用不删除 |
| inventory_locations | id, location_code(unique), name, is_active, notes, created_at, updated_at | 多库存地点（种子：MAIN_STORAGE 总仓 / FRONT_DESK 前台 / HOUSEKEEPING 保洁间 / MAINTENANCE 维修间） |
| inventory_balances | id, item_id(FK RESTRICT), location_id(FK RESTRICT), quantity(Numeric(12,2)), updated_at | **余额 Projection（投影），不是独立事实**；UNIQUE(item_id, location_id)；CHECK `quantity >= 0`；每次库存事务与 StockMovement 同事务更新 |
| stock_movements | id, movement_no(unique), item_id, location_id, movement_type(枚举), quantity(signed), reference_type, reference_id, reason, created_by_user_id(SET NULL), created_at | **永久库存账本事实（immutable ledger）**；无普通 PATCH / DELETE 通道；CHECK 按类型校验符号（PURCHASE_RECEIPT/RETURN/TRANSFER_IN/ADJUSTMENT_IN > 0；ISSUE/TRANSFER_OUT/ADJUSTMENT_OUT < 0；INITIAL >= 0） |
| stock_issues | id, issue_no(unique), source_location_id, destination_type(枚举), room_id(FK RESTRICT, nullable), notes, created_by_user_id, created_at | 领用单（多行整体原子）；CHECK `destination_type='ROOM' AND room_id IS NOT NULL OR destination_type<>'ROOM' AND room_id IS NULL` |
| stock_issue_lines | id, issue_id(FK CASCADE), item_id(FK RESTRICT), quantity | 领用行；CHECK `quantity > 0` |

### Inventory 域 PG 枚举

```text
item_category:            GUEST_AMENITY / LINEN / CLEANING / FRONT_DESK /
                          MAINTENANCE / OFFICE / OTHER
movement_type:            INITIAL / PURCHASE_RECEIPT / ISSUE / RETURN /
                          TRANSFER_OUT / TRANSFER_IN / ADJUSTMENT_IN /
                          ADJUSTMENT_OUT
issue_destination_type:   HOUSEKEEPING / FRONT_DESK / MAINTENANCE / ROOM / OTHER
```

### 业务单号 Sequence

- `stock_movement_no_seq`（SMV{YYYYMMDD}-{NNNN}）/ `stock_issue_no_seq`（SIS{YYYYMMDD}-{NNNN}）
- 应用层 `nextval` 原子取号（日期 = Property Business Date），UNIQUE 约束兜底。禁止 SELECT MAX+1。

### 关键不变量（Sprint 7 §2 LOCKED）

- **no movement = no stock change**：库存变化只能来自业务动作；
  不允许直接 PATCH quantity / current_stock / balance。
- **Ledger == Balance**：`InventoryBalance.quantity == SUM(StockMovement.quantity)`
  for (item, location)，覆盖 INITIAL / ISSUE / RETURN / TRANSFER / ADJUSTMENT /
  PURCHASE_RECEIPT 全部正常业务路径。
- **无负库存**：所有减少库存的操作 SELECT ... FOR UPDATE -> recheck quantity
  -> movement -> balance update；不足返回 409；DB CHECK `quantity >= 0` 兜底。
- 总库存 = SUM(所有已持久化 Balance)，已停用 Location 的库存**不**静默消失（UI 标记 inactive）。

## Procurement 域表结构（Sprint 7，Migration `e3a91f5c8d24`）

| 表 | 关键字段 | 说明 |
|---|---|---|
| suppliers | id, supplier_code(unique), name, contact_name, phone, wechat, notes, is_active, created_at, updated_at | 供应商（无银行/税务/合同字段）；停用不删除 |
| purchase_requests | id, request_no(unique), status(枚举), requested_by_user_id, approved_by_user_id, submitted_at, approved_at, rejected_at, cancelled_at, notes, created_at, updated_at | 采购申请；状态机 DRAFT→SUBMITTED→APPROVED→ORDERED、SUBMITTED→REJECTED、DRAFT/APPROVED→CANCELLED |
| purchase_request_lines | id, request_id(FK CASCADE), item_id(FK RESTRICT), quantity, notes | 申请行；CHECK `quantity > 0` |
| purchase_orders | id, order_no(unique), supplier_id(FK RESTRICT), purchase_request_id(FK RESTRICT, nullable, **UNIQUE**), status(枚举), ordered_at, cancelled_at, created_by_user_id, notes, created_at, updated_at | 采购订单；**一张 Request 至多一张 PO**（DB UNIQUE 最终仲裁）；状态机 DRAFT→ORDERED→PARTIALLY_RECEIVED→RECEIVED、DRAFT/ORDERED/PARTIALLY_RECEIVED→CANCELLED |
| purchase_order_lines | id, order_id(FK CASCADE), item_id(FK RESTRICT), ordered_quantity, received_quantity, unit_price(Numeric(12,2)) | 订单行；CHECK `ordered_quantity > 0` / `received_quantity >= 0` / **`received_quantity <= ordered_quantity`**（数据库级防超收） |
| goods_receipts | id, receipt_no(unique), purchase_order_id(FK RESTRICT), inventory_location_id(FK RESTRICT), received_by_user_id, received_at, notes, created_at | 收货单；**收货才是库存增加权威**；历史不删除 |
| goods_receipt_lines | id, receipt_id(FK CASCADE), purchase_order_line_id(FK RESTRICT), received_quantity | 收货行；CHECK `received_quantity > 0` |

### Procurement 域 PG 枚举

```text
purchase_request_status:  DRAFT / SUBMITTED / APPROVED / ORDERED /
                          REJECTED / CANCELLED
purchase_order_status:    DRAFT / ORDERED / PARTIALLY_RECEIVED /
                          RECEIVED / CANCELLED
```

### 业务单号 Sequence

- `purchase_request_no_seq`（PRQ{YYYYMMDD}-{NNNN}）/ `purchase_order_no_seq`（PO{YYYYMMDD}-{NNNN}）/ `goods_receipt_no_seq`（GR{YYYYMMDD}-{NNNN}）
- 原子取号 + UNIQUE 兜底，禁止 SELECT MAX+1。

### 关键语义（Sprint 7 §27/§28/§31/§33）

- **PO 不改变库存**：DRAFT / ORDERED PO 均无 movement / balance 变化；
  只有 Goods Receipt 创建 PURCHASE_RECEIPT movement 并增加库存。
- **部分收货**：cumulative received <= ordered（PO 行锁串行化 + DB CHECK）；
  PO 状态由收货推导（全部收满 → RECEIVED，否则 PARTIALLY_RECEIVED）。
- **PARTIALLY_RECEIVED → CANCELLED**：代表「不再收剩余数量」，
  已收货库存与历史保持；RECEIVED 终态不可取消。
- 金额使用 Numeric/Decimal（禁止 float 存金额）；S7 不做付款/应付/发票/税务。

## AI Manager 域表结构（Sprint 9，Migration `f5d3b9e7a2c4`）

| 表 | 关键字段 | 说明 |
|---|---|---|
| ai_settings | id(PK, CHECK id=1 单行), provider, api_key_encrypted(Text, nullable), model, updated_by_user_id(FK SET NULL), updated_at | DeepSeek 配置；**API Key 只存 Fernet 密文**（cryptography，密钥来自后端环境变量 `AI_ENCRYPTION_KEY`，与密文分离）；任何接口/日志/审计不返回完整 Key |
| ai_conversations | id, user_id(FK CASCADE), title, created_at, updated_at | AI 对话（页面刷新恢复会话用） |
| ai_messages | id, conversation_id(FK CASCADE), role(CHECK user/assistant/tool), content(Text), model, provider, usage_json(JSONB), created_at | 只存 user/assistant 消息与 usage；**工具消息与完整原始 SQL 结果不落库** |

### AI 只读视图（21 个 `ai_*`，数据库级表/字段白名单）

- **operations 域**：ai_room_types / ai_rooms（含 name / is_active）/ **ai_channels**（alpha.9.6 F3）/ ai_reservations（无 guest_id、
  无金额、无 notes）/ ai_stays / ai_stay_room_assignments /
  ai_housekeeping_tasks / ai_maintenance_work_orders / ai_users（无
  email/phone/password_hash）
- **business 域**：ai_inventory_items / ai_inventory_locations /
  ai_inventory_balances / ai_stock_movements / ai_stock_issues /
  ai_stock_issue_lines / ai_suppliers（无 phone/wechat/notes）/
  ai_purchase_requests / ai_purchase_request_lines / ai_purchase_orders /
  ai_purchase_order_lines / ai_goods_receipts / ai_goods_receipt_lines
- **不含 guests 表**：Guest PII（姓名/手机/邮箱/备注）完全不开放给 AI

### stayops_ai_reader 只读 Role（§13/§30 数据库级写保护）

```sql
-- 由 Migration f5d3b9e7a2c4 创建（幂等；密码来自后端配置 settings.ai_reader_database_password）
CREATE ROLE stayops_ai_reader LOGIN PASSWORD '<backend-config>'
    NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE <db> TO stayops_ai_reader;
REVOKE ALL ON SCHEMA public FROM stayops_ai_reader;
GRANT USAGE ON SCHEMA public TO stayops_ai_reader;
GRANT SELECT ON <每个 ai_* 视图> TO stayops_ai_reader;   -- 21 个视图
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO stayops_ai_reader;
```

- 无任何基表 INSERT/UPDATE/DELETE/TRUNCATE/CREATE/ALTER/DROP 权限：
  即使应用层 SQL Validator 失效，PostgreSQL 自身仍拒绝写操作
  （permission denied / must be owner）。
- 角色为集群级对象：downgrade 不 DROP ROLE（避免影响其它数据库），只撤销授权。
- AI SQL 执行器额外使用 `SET TRANSACTION READ ONLY` + `statement_timeout` +
  行数上限（默认 200 / 硬上限 500），密码绝不进入 Prompt/日志。

## 约定

- PostgreSQL 16，通过 Docker Compose 提供开发实例（`stayops` 库；pytest 用独立 `stayops_test` 库）
- Schema 修改必须使用 Alembic Migration（禁止直接改表）
- 凭据不硬编码进 Git，通过 `.env` 加载
- 种子数据（权限/角色/admin/28 房间/6 房型/4 库存地点）由 `python -m app.seed` 幂等写入；Sprint 2 新增 9 个 Booking 权限码（共 26 个），Sprint 3 新增 5 个 Housekeeping 权限码（共 31 个），Sprint 5 新增 5 个 Maintenance 权限码（共 36 个），Sprint 6 新增 1 个 Room Move 权限码（共 37 个），Sprint 7 新增 11 个 Inventory/Procurement 权限码（共 48 个），Sprint 8 新增 2 个 Analytics 权限码（共 50 个），Sprint 9 新增 2 个 AI Manager 权限码（共 52 个），seed 幂等收敛不变
