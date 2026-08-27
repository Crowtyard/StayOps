# StayOps API

> Sprint 1 第二阶段已实现，Sprint 2 S2-T1 扩展 Booking 域，Sprint 3 扩展 Housekeeping 域。统一前缀 `/api/v1`，JSON 请求/响应，JWT（Bearer）认证。

## 约定

- **认证**：`Authorization: Bearer <access_token>`（登录接口返回）；未认证 401，权限不足 403，资源不存在 404，唯一键冲突/非法状态转换 409，参数校验失败 422
- **错误格式**：FastAPI 默认 `{"detail": "..."}`
- **分页**：列表接口统一 `?page=1&page_size=20`（page_size 上限 100），返回 `{"items": [...], "total": n, "page": 1, "page_size": 20}`
- **审计**：所有写操作（含登录成功/失败）写 `audit_logs`，含操作人、action、资源、details 摘要与 IP（优先 `X-Forwarded-For` 首段）；details 不含密码/Token
- **金额**：`base_price` 为 Decimal，JSON 序列化为字符串（如 `"328.00"`，避免浮点精度问题），提交时接受数字或字符串
- **密码**：仅存 bcrypt 哈希；任何响应/日志不返回密码与哈希
- 开发管理员：`admin` / `Admin@123456`（仅开发环境）

## 端点一览

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | /auth/login | 登录，返回 access_token | 公开 |
| GET | /auth/me | 当前用户 + 角色 + 权限 code 列表 | 登录 |
| GET | /users | 用户列表（分页） | user:read |
| POST | /users | 创建用户 | user:write |
| GET | /users/{id} | 用户详情 | user:read |
| PUT | /users/{id} | 更新用户（可改密码/启用禁用；不可禁用自己） | user:write |
| DELETE | /users/{id} | 删除用户（不可删除自己） | user:delete |
| POST | /users/{id}/roles | 分配角色（整体替换，空=清空） | user:write |
| GET | /roles | 角色列表（分页） | role:read |
| POST | /roles | 创建角色 | role:write |
| GET | /roles/{id} | 角色详情 | role:read |
| PUT | /roles/{id} | 更新角色 | role:write |
| DELETE | /roles/{id} | 删除角色（级联清理关联） | role:delete |
| POST | /roles/{id}/permissions | 设置角色权限（整体替换，空=清空） | role:write |
| GET | /permissions | 权限列表（分页，31 个 = Sprint 1 的 17 + Booking 的 9 + Housekeeping 的 5） | role:read |
| GET | /room-types | 房型列表（分页，含 room_count） | room_type:read |
| POST | /room-types | 创建房型 | room_type:write |
| GET | /room-types/{id} | 房型详情 | room_type:read |
| PUT | /room-types/{id} | 更新房型 | room_type:write |
| DELETE | /room-types/{id} | 删除房型（有房间时 409） | room_type:delete |
| GET | /rooms | 房间列表（分页，`?occupancy_status=` / `?cleaning_status=` / `?room_type_id=` 筛选） | room:read |
| POST | /rooms | 创建房间（occupancy_status 默认 available，cleaning_status 默认 clean） | room:write |
| GET | /rooms/{id} | 房间详情 | room:read |
| PUT | /rooms/{id} | 更新房间基础信息（不含状态） | room:write |
| DELETE | /rooms/{id} | 删除房间 | room:delete |
| POST | /rooms/{id}/status | 房态变更（状态机校验，非法 409；写审计） | room:write 或 room:status_cleaning / room:status_maintenance（对应目标房态） |
| GET | /audit-logs | 审计日志列表（分页，`?action=` / `?user_id=` / `?resource_type=` 筛选） | audit:read |
| GET | /guests | 客人列表（分页，`?search=` 匹配 name OR phone） | guest:read |
| POST | /guests | 创建客人 | guest:write |
| GET | /guests/{id} | 客人详情 | guest:read |
| PATCH | /guests/{id} | 更新客人 | guest:write |
| GET | /availability | 可售性查询（`?check_in_date=&check_out_date=&room_type_id=`，返回全量房间 + 可售标注） | reservation:read |
| GET | /reservations | 预订列表（分页，筛选见下） | reservation:read |
| POST | /reservations | 创建预订（CONFIRMED） | reservation:write |
| GET | /reservations/{id} | 预订详情 | reservation:read |
| PATCH | /reservations/{id} | 修改预订（仅 CONFIRMED） | reservation:write |
| POST | /reservations/{id}/cancel | 取消预订（CONFIRMED → CANCELLED） | reservation:cancel |
| POST | /reservations/{id}/no-show | 标记未到店（CONFIRMED → NO_SHOW，需 business_date ≥ check_in_date） | reservation:no_show |
| POST | /reservations/{id}/check-in | 办理入住（单事务：Reservation CHECKED_IN + Stay ACTIVE + Room occupied + 审计） | stay:check_in |
| GET | /stays | 入住列表（分页，`?status=` / `?room_id=` / `?planned_check_out_date=`） | stay:read |
| GET | /stays/{id} | 入住详情 | stay:read |
| POST | /stays/{id}/check-out | 办理退房（单事务：Stay CHECKED_OUT + Reservation COMPLETED + Room available+dirty + **Housekeeping Task PENDING 自动创建** + 审计） | stay:check_out |
| GET | /housekeeping/tasks | 保洁任务列表（分页，`?status=` / `?room_id=` / `?assigned_to_user_id=` / `?priority=` / `?source=` / `?search=`（task_no OR room_no，非 PII）） | housekeeping_task:read |
| POST | /housekeeping/tasks | 手动创建任务（仅 dirty 且非 occupied 房间；已有进行中任务 409） | housekeeping_task:write |
| GET | /housekeeping/tasks/{id} | 任务详情（无 Guest / Reservation 数据） | housekeeping_task:read |
| PATCH | /housekeeping/tasks/{id} | 派单/改派/取消派单（`assigned_to_user_id` 显式 null）/ priority / notes；仅进行中任务；strict schema（含 status 的 payload → 422，空 payload → 422） | housekeeping_task:write |
| POST | /housekeeping/tasks/{id}/start | 开始清扫（PENDING/REWORK → IN_PROGRESS；Room → cleaning；单事务） | housekeeping_task:work |
| POST | /housekeeping/tasks/{id}/submit-inspection | 提交验房（IN_PROGRESS → INSPECTION；Room → inspection；单事务） | housekeeping_task:work |
| POST | /housekeeping/tasks/{id}/pass | 验收通过（INSPECTION → COMPLETED；Room → clean；单事务） | housekeeping_task:inspect |
| POST | /housekeeping/tasks/{id}/rework | 返工（INSPECTION → REWORK；Room → rework；单事务） | housekeeping_task:inspect |
| POST | /housekeeping/tasks/{id}/cancel | 取消任务（进行中 → CANCELLED；Room → dirty；单事务） | housekeeping_task:cancel |
| GET | /housekeeping/assignees | 派单候选人（持有 housekeeping_task:work 的在职用户；不要求 user:read） | housekeeping_task:write |

## 认证与权限

- JWT HS256，`sub`=用户 id，有效期 12 小时（`access_token_expire_minutes`）
- 权限解析链：users → user_roles → roles → role_permissions → permissions（按 code 校验）
- 角色权限映射见种子（`backend/app/seed.py`）；SUPER_ADMIN 动态拥有全部权限
- 账号禁用后旧 Token 立即失效（403）

## 房态状态机（双维度）

`rooms.occupancy_status` / `rooms.cleaning_status` 相互独立，仅通过 `POST /rooms/{id}/status` 变更（body 至少提供一个维度；PUT 不接收状态字段）。非法转换 409。

| 维度 | 当前状态 | 允许转换到 |
|---|---|---|
| 占用 | available | reserved / occupied / blocked / out_of_service |
| 占用 | reserved | available / occupied / blocked / out_of_service |
| 占用 | occupied | available / reserved / out_of_service |
| 占用 | blocked | available / out_of_service |
| 占用 | out_of_service | available / blocked |
| 清洁 | clean | dirty |
| 清洁 | dirty | cleaning |
| 清洁 | cleaning | clean / inspection / rework |
| 清洁 | inspection | clean / rework |
| 清洁 | rework | cleaning |

同一状态转换视为非法（409）；两维度互不约束（如 reserved+dirty 合法）。鉴权：`room:write` 可改任意维度；`room:status_cleaning` 仅清洁维度；`room:status_maintenance` 仅把占用置为 out_of_service；无 `room:write` 不允许同时改两维度（403）。

## 前端 BFF 端点（Next.js Route Handler，T3a）

浏览器不接触 JWT；前端统一经以下端点（同源 `http://localhost:3000`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/login | 转发后端登录，成功写 HttpOnly Cookie `stayops_token`，返回用户+角色+权限（同 `MeOut`） |
| GET | /api/auth/me | 读 Cookie 调后端 /auth/me；401 时清 Cookie |
| POST | /api/auth/logout | 清 Cookie |
| * | /api/bff/{...path} | 通用代理 → `BACKEND_API_URL/api/v1/{...path}`：附加 Bearer、透传查询串/请求体/状态码/`detail`、转发 X-Forwarded-For；后端不可达 502 |

## Booking 域（Sprint 2 · S2-T1）

### Property Business Date

- 所有业务日期判断统一使用 **Asia/Shanghai（UTC+8）当前日期**（`business_date`）：Check-in 资格、No-show 资格、Availability 的「今天」、WALK_IN 默认 check_in_date。
- 日期区间统一 `[check_in_date, check_out_date)`：包含入住日、不含退房日；紧邻允许、重叠 409；`check_out_date <= check_in_date` → 422。
- 时间戳（actual_check_in_at / actual_check_out_at / created_at / updated_at）一律 timezone-aware。

### Reservation / Stay 状态机

```text
Reservation: CONFIRMED ── CANCELLED / NO_SHOW / CHECKED_IN ──(仅 Check-out 事务)── COMPLETED
Stay:        ACTIVE ── CHECKED_OUT（终态）
```

- 状态只能经专用 action 端点变更（cancel / no-show / check-in / check-out）；PATCH 不含 status 字段。
- Check-in 资格：`status = CONFIRMED` 且 `business_date ∈ [check_in_date, check_out_date)`；未来提前入住 409、已过 check_out_date 409。
- No-show 资格：`status = CONFIRMED` 且 `business_date >= check_in_date`；未来预订 409。
- `CHECKED_IN → COMPLETED` 只能由 Stay Check-out 事务触发（REV-01）。

### PII 与权限裁剪（REV-02 / REV-FINAL-04）

- `GET /guests*` 无 `guest:read` → 整体 403。
- 无 `guest:read` 时，任何响应（reservations / stays 等）不含 `name / phone / email / Guest notes / guest_name`，仅保留 `guest_id` 供关系关联。
- 无 `reservation:read` 时，不含 `reservation_no`、日期、房号/房型、source、status、`agreed_total_amount`、currency、Reservation notes（含嵌套）。
- 实现：service 层按权限构建响应字段；路由 `response_model_exclude_none=True` —— 被裁剪字段与 null 字段（如未退房的 `actual_check_out_at`）以「键缺失」呈现，而不是 null。
- HOUSEKEEPING 两者皆无：Booking 端点全部 403，仅能经 Rooms API 看到房态（如 dirty）。

### 409 场景清单（Booking 域）

Double Booking（含并发撞排他约束 23P01）、blocked / out_of_service 房间、区间含业务日期当天时 occupied / reserved 房间、Active Stay 重叠、Dirty room Check-in、Occupied room Check-in、Check-in 日期资格不符（提前/过期）、未来预订 No-show、CANCELLED / NO_SHOW 后续操作、已 Check-in 重复 Check-in、非 ACTIVE Stay Check-out、已退房重复 Check-out、非法状态机转换、非 CONFIRMED 状态 PATCH。422：日期非法（co <= ci / 格式错误）、Room / Room Type 不一致（REV-FINAL-06）。

### 响应示例

`GET /api/v1/availability?check_in_date=2026-08-30&check_out_date=2026-09-01`（日期为示例，实现一律动态）：

```json
{
  "business_date": "2026-08-26",
  "check_in_date": "2026-08-30",
  "check_out_date": "2026-09-01",
  "total": 28,
  "available_count": 27,
  "items": [
    {
      "room_id": 13,
      "room_number": "203",
      "room_type_id": 3,
      "room_type_name": "豪华大床房",
      "floor": 2,
      "available": true,
      "reason": null
    },
    {
      "room_id": 1,
      "room_number": "101",
      "room_type_id": 1,
      "room_type_name": "标准大床房",
      "floor": 1,
      "available": false,
      "reason": "该房间在所选日期区间已被预订"
    }
  ]
}
```

`POST /api/v1/reservations/{id}/check-in` 返回 `{"reservation": {...}, "stay": {...}}`（Stay 含 `stay_no`、`actual_check_in_at`、`planned_check_out_date`，供退房流程使用）。

### 业务单号

`reservation_no` / `stay_no` / `task_no` 服务端生成：`RSV{YYYYMMDD}-{NNNN}` / `STY{YYYYMMDD}-{NNNN}` / `HKT{YYYYMMDD}-{NNNN}`（日期 = Property Business Date；NNNN = PG Sequence 原子取号，唯一约束兜底）。禁止客户端传入。

## Housekeeping 域（Sprint 3）

### 状态机（后端唯一权威，非法跳转 409）

```text
PENDING → IN_PROGRESS → INSPECTION → COMPLETED（终态）
                ▲             │
                └─ REWORK ◄───┘
任意进行中状态 → CANCELLED（终态）
```

状态只能经专用 action 端点变更（start / submit-inspection / pass / rework / cancel）；PATCH 不含 status 字段。

### Task ↔ Room.cleaning_status 原子联动（与审计同事务，任一步失败全部回滚）

```text
PENDING → dirty   IN_PROGRESS → cleaning   INSPECTION → inspection
REWORK  → rework  COMPLETED    → clean     CANCELLED   → dirty
```

### Checkout 集成

退房事务原子完成：`Stay CHECKED_OUT + Reservation COMPLETED + Room available+dirty + HousekeepingTask PENDING（source=CHECKOUT）+ housekeeping.create 审计`；任务创建失败 → 整个退房 rollback。

### Active Task 唯一

一个 Room 至多一个进行中任务（PENDING/IN_PROGRESS/INSPECTION/REWORK），数据库部分唯一索引最终仲裁；并发重复创建 → 409「该房间已有进行中的保洁任务」。

### 409 场景清单（Housekeeping 域）

非 dirty 房间手动创建、occupied 房间手动创建（不做住中保洁）、Active Task 重复（含并发）、非法状态转换（start/submit/pass/rework/cancel 的目标状态不合法）、终态任务 PATCH。422：未知字段（含 status）、空 payload、被指派人不存在/停用。

### 响应示例

`GET /api/v1/housekeeping/tasks/{id}`（`response_model_exclude_none`：null 字段以键缺失呈现）：

```json
{
  "id": 1,
  "task_no": "HKT20260827-0001",
  "room_id": 12,
  "room_number": "203",
  "status": "IN_PROGRESS",
  "priority": "URGENT",
  "source": "CHECKOUT",
  "assigned_to_user_id": 9,
  "assignee_name": "保洁小王",
  "notes": null,
  "started_at": "2026-08-27T22:00:00+08:00",
  "created_at": "2026-08-27T21:59:00+08:00",
  "updated_at": "2026-08-27T22:00:00+08:00"
}
```

（示例日期仅为文档说明；自动化测试一律动态日期。任务响应不含任何 Guest / Reservation 数据。）

## 示例

```powershell
# 登录（直连后端）
curl.exe -X POST http://localhost:8000/api/v1/auth/login `
  -H "Content-Type: application/json" `
  -d '{"username":"admin","password":"Admin@123456"}'

# 带 Token 查询房间（第一页 20 条）
curl.exe "http://localhost:8000/api/v1/rooms?page=1&page_size=20" `
  -H "Authorization: Bearer <access_token>"

# 变更房态（经前端 BFF，Cookie 认证）
curl.exe -c cookies.txt -X POST http://localhost:3000/api/auth/login `
  -H "Content-Type: application/json" `
  -d '{"username":"admin","password":"Admin@123456"}'
curl.exe -b cookies.txt -X POST http://localhost:3000/api/bff/rooms/1/status `
  -H "Content-Type: application/json" `
  -d '{"occupancy_status":"occupied"}'
```
