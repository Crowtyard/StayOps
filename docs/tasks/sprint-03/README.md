# StayOps Sprint 3 Task Specification — Housekeeping Operations & Room Turnover

> 开发模式：**FAST TRACK + REUSE FIRST + ONE SPRINT / ONE DSH SESSION**（不再拆分 S3-T1/T2/T3）。
> 由 DSH Agent 一个会话内完成 Implementation Recon → Database → Backend → API → Frontend → Integration → pytest → Vitest → Playwright E2E → Documentation → Completion Report；完成后停止，等待 Kun Independent Fast QA。
> 本 Sprint 允许修改 `backend/`、`frontend/`、`docs/`；不 Commit / Push / Tag / Release（Fast QA PASS 后由 Kun 统一执行）。

## 1. Goal（目标）

把住宿业务链后半段补完整，实现「翻房闭环（Room Turnover）」：

```text
Check-out → Dirty Room → 自动 Housekeeping Task → 派单 → 开始清扫
→ 待验房 → PASS / REWORK → Clean Room → 下一位 Guest 可以入住
```

## 2. Golden Path（最高优先级验收条件）

```text
Reservation → Check-in → Check-out → Room available + dirty
→ Housekeeping Task PENDING 自动创建（同一退房事务）
→ Assign → HOUSEKEEPING Start → Room cleaning
→ Submit Inspection → Room inspection → PASS
→ Task COMPLETED + Room available + clean
→ 下一笔日期资格正确的 Reservation → Check-in SUCCESS
```

返工分支：`PENDING → IN_PROGRESS → INSPECTION → REWORK → IN_PROGRESS → INSPECTION → COMPLETED`，每一步 `Task.status` 与 `Room.cleaning_status` 原子一致。

## 3. 数据模型（Migration `77ec5f0c543e`）

`housekeeping_tasks`：`id / task_no(unique) / room_id(FK rooms RESTRICT) / status / priority / source / assigned_to_user_id(FK users SET NULL) / notes / started_at / submitted_for_inspection_at / completed_at / cancelled_at / created_by / updated_by / created_at / updated_at`。

- PG 枚举：`hk_task_status`（PENDING / IN_PROGRESS / INSPECTION / REWORK / COMPLETED / CANCELLED）、`hk_task_source`（CHECKOUT / MANUAL）、`hk_task_priority`（NORMAL / URGENT）
- `task_no` = `HKT{YYYYMMDD}-{NNNN}`：PG Sequence `housekeeping_task_no_seq` 原子生成 + UNIQUE 约束（禁止 SELECT MAX+1）
- **Active Task 数据库级唯一**：部分唯一索引
  `uq_housekeeping_tasks_active_room ON (room_id) WHERE status IN ('PENDING','IN_PROGRESS','INSPECTION','REWORK')`
  —— 一个 Room 同时至多一个进行中任务；并发重复创建由数据库最终仲裁（23505 → 409）
- Housekeeping 域不保存任何 Guest PII（不关联 Guest / Reservation）

## 4. 状态机与房态联动（后端唯一权威）

```text
PENDING → IN_PROGRESS → INSPECTION → COMPLETED（终态）
                ▲             │
                └─ REWORK ◄───┘
任意进行中状态 → CANCELLED（终态；房间回置 dirty）
```

`Task.status + Room.cleaning_status + Audit` 同一数据库事务完成，任一步失败全部回滚：

```text
PENDING → dirty   IN_PROGRESS → cleaning   INSPECTION → inspection
REWORK  → rework  COMPLETED    → clean     CANCELLED   → dirty
```

非法跳转 409；状态只能经专用 action 端点变更（start / submit-inspection / pass / rework / cancel），PATCH 不含 status（strict schema，携带即 422）。

## 5. Checkout 集成（原子不变式）

`Stay=CHECKED_OUT + Reservation=COMPLETED + Room=available+dirty + HousekeepingTask=PENDING` 为同一退房事务；任务创建失败 → 整个退房 rollback（不得出现「已退房但没有翻房任务」）。

## 6. 手动任务与派单

- 手动创建：仅 `cleaning_status = dirty` 且非 `occupied` 的房间（不做住中保洁）；已有进行中任务 → 409
- PATCH 仅限 `priority / assigned_to_user_id / notes`（`assigned_to_user_id` 显式 null = 取消派单）；仅进行中任务可修改；终态 PATCH → 409
- 派单候选人：`GET /housekeeping/assignees`（需 `housekeeping_task:write`；返回持有 `housekeeping_task:work` 的在职用户；不暴露 Guest PII，也不要求 user:read）

## 7. RBAC

新增权限：`housekeeping_task:read / write / work / inspect / cancel`（共 31 个权限码 = 17 + 9 + 5）。

| 角色 | 权限 |
|---|---|
| SUPER_ADMIN | 全部（动态） |
| MANAGER | 全部 5 个 |
| FRONT_DESK | read + write（创建/派单；不可 start/submit/pass/rework/cancel） |
| HOUSEKEEPING | read + work + inspect（执行清扫链；不可创建/修改/取消） |
| MAINTENANCE / FINANCE | 无 |

## 8. API（前缀 `/api/v1`）

```text
GET    /housekeeping/tasks            列表（status/room_id/assigned_to_user_id/priority/source/search=task_no|room_no + 分页）
POST   /housekeeping/tasks            手动创建（source=MANUAL）
GET    /housekeeping/tasks/{id}       详情
PATCH  /housekeeping/tasks/{id}       assignment/priority/notes（strict）
POST   /housekeeping/tasks/{id}/start
POST   /housekeeping/tasks/{id}/submit-inspection
POST   /housekeeping/tasks/{id}/pass
POST   /housekeeping/tasks/{id}/rework
POST   /housekeeping/tasks/{id}/cancel
GET    /housekeeping/assignees        派单候选人（housekeeping_task:write）
```

错误语义沿用：401 未认证 / 403 无权限 / 404 不存在 / 409 状态冲突与 Active Task 唯一冲突 / 422 输入校验（含未知字段与空 payload）。

## 9. Audit

`housekeeping.create / housekeeping.assign / housekeeping.update / housekeeping.start / housekeeping.submit_inspection / housekeeping.pass / housekeeping.rework / housekeeping.cancel`（与业务同事务；details 仅任务单号/房号/来源/优先级/状态与 stay 关联，无 PII、无金额）。Checkout 自动任务落 `housekeeping.create` 并携带 `stay_id / stay_no` 可追溯。

## 10. Frontend

- 主导航新增「保洁」（`housekeeping_task:read`）
- `/housekeeping` 保洁运营工作台：状态视图（待清扫/清扫中/待验房/返工/已完成 + 全部）、任务卡片（房间号/状态/优先级/保洁员/更新时间）、一到两次点击的快捷操作（开始清扫/提交验房/通过/返工/取消）、新建任务（dirty 房间选择）
- `/housekeeping/[id]` 任务详情：任务信息 + 房间现场状态 + 派单与调整（候选人选择/优先级/备注）+ 操作确认
- Dashboard 增加「保洁运营概览」（待清扫/清扫中/待验房/返工；无权限不请求不显示）
- Room Detail 增加「保洁任务」摘要卡（状态/优先级/保洁员；无权限不请求）
- PII：任务页面不含任何 Guest 身份/联系方式/预订数据

## 11. 测试基线（不得删改旧测试）

```text
pytest     ≥ 167（Sprint 3 新增 housekeeping 域用例后实际 202）
Vitest     ≥ 139（实际 170）
Playwright ≥ 29（实际 36 = 29 + housekeeping 2 个 spec 7 条）
pytest 与 E2E 不得并行运行（共享 stayops_test）
```

所有自动化日期基于 Property Business Date（Asia/Shanghai）动态生成。

## 12. Out of Scope

Maintenance / Inventory / Procurement / Linen / Laundry / Stay-over Cleaning / Staff Scheduling / Attendance / Payroll / Lost & Found / OTA / Payment / Invoice / CRM / Membership / 公安登记 / OCR / 人脸 / 智能门锁 / Revenue Management / AI Manager / Complex Analytics。

## 13. Definition of Done

Checkout 自动建任务 · Task↔Room 原子同步 · Active Task 数据库级唯一 · Assignment 可用 · 工作台可用 · 正常清扫链闭环 · Rework 闭环 · Check-in clean gating 保持 · RBAC 正确 · PII 无泄漏 · Audit 正确 · Dashboard / Room Detail 集成 · 并发安全 · 事务回滚正确 · Clean Bootstrap PASS · Sprint 1/2 无回归 · pytest / Vitest / Playwright 全绿。

## 14. Git

整个 Sprint：NO COMMIT / NO PUSH / NO TAG / NO RELEASE。Kun Fast QA PASS 后由 Kun 执行 Commit / Push / Tag `v1.0.0-alpha.3`。
