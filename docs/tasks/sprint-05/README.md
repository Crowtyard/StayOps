# Sprint 5 — Maintenance Operations & Room Readiness（维修运营与客房可用性闭环）

- 计划版本：`v1.0.0-alpha.5`
- 开发模式：FAST TRACK / REUSE FIRST / ONE SPRINT / ONE DSH SESSION（不拆 T1/T2/T3）
- 基线：v1.0.0-alpha.4（commit `f425b9c234ae8fb214e543531f5cb3e6041accb0`）
- 状态：IMPLEMENTATION COMPLETE + FAST QA FIX COMPLETE（本会话实现，无 commit；等待 Kun Fast RE-QA）

> Fast QA 修复（2026-09-02）：Kun Blocking Defect「occupied + blocking MWO + 未来预订 → 前台无主动维修风险」。
> 修复 = Front Desk Attention 新增 Rule M（预订存在维修风险）：
> CONFIRMED + check_in ≥ 今日 + Active Blocking MWO（OPEN/ASSIGNED/IN_PROGRESS/RESOLVED），
> 与 Room occupancy 无关；一条预订一条卡片（多工单合并计数）；M 优先抑制同预订 Rule C；
> MANUAL blocked/OOS 无工单时 Rule C 继续；桌面 Attention Drawer + Mobile Today Board 共享；
> 仅 maintenance_order:read 加载工单数据（不扩大权限/无新请求）。
> 后端规则零改动。Vitest 285 → 300；Playwright 59 → 60；pytest 285 不变。

## 1. Product Goal

在 Reservation / Check-in / Stay / Check-out / Housekeeping / Front Desk 之上，
建立正式的 Maintenance Operations（维修运营）能力，形成完整闭环：

```text
Issue Reported → Maintenance Work Order → Assign → Repair → Resolve
→ Verify / Rework → Complete → Room Ready
```

支持 PRE_OPENING 场景（开业前 28 间客房设施检查和整改）。

## 2. 领域原则

**Maintenance Status ≠ Room Occupancy Status ≠ Cleaning Status**。
维修工单（MaintenanceWorkOrder）是第三个独立业务领域，不塞进 Room 单状态。

## 3. blocked / out_of_service 语义锁定

- `blocked`：运营/人工原因主动锁房（内部预留、特殊用途、管理层暂停销售、计划装修）。
- `out_of_service`：因设施、维修、安全或客房本身问题，当前不适合正常投入住宿经营。
- Maintenance 不得把 Room 设置为 blocked。

## 4. Room Unavailability Source

新增 Room metadata `unavailability_source`（enum：MANUAL / MAINTENANCE，nullable）：

- available / reserved / occupied → normally null
- blocked → MANUAL
- out_of_service → MANUAL or MAINTENANCE

迁移安全处理历史 Room：existing blocked / out_of_service → MANUAL；其它 → null。
CHECK 约束 `ck_rooms_unavailability_source` 数据库级兜底。

## 5. MaintenanceWorkOrder

字段：id / work_order_no / room_id / category / severity / status / source /
blocks_room / title / description / reported_by_user_id / assigned_to_user_id /
verified_by_user_id / resolution_notes / verification_notes /
started_at / resolved_at / verified_at / completed_at / cancelled_at /
created_by / updated_by / created_at / updated_at。

Work Order No：`MWO{YYYYMMDD}-{NNNN}`（PG Sequence + UNIQUE，禁止 SELECT MAX+1）。

## 6–8. 枚举

- Category（第一版固定）：ELECTRICAL / PLUMBING / HVAC / LOCK / BATHROOM /
  FURNITURE / APPLIANCE / NETWORK / FINISHING / OTHER
- Severity：LOW / MEDIUM / HIGH / CRITICAL（severity ≠ blocks_room，CRITICAL 不自动阻断）
- Source：MANUAL / FRONT_DESK / HOUSEKEEPING / PRE_OPENING（开业前整改复用维修域）

## 9. 状态机

```text
OPEN → ASSIGNED → IN_PROGRESS → RESOLVED → COMPLETED（终态）
  │                    ▲              │  │
  │                    └── Rework ────┘  └── CANCELLED（终态）
```

start 仅 ASSIGNED → IN_PROGRESS；rework 仅 RESOLVED → IN_PROGRESS。
Verify 动作：RESOLVED → COMPLETED，记录 verified_at / verified_by / verification_notes。

## 11. blocks_room 语义

Active Blocking = blocks_room=true 且状态 ∈ OPEN / ASSIGNED / IN_PROGRESS / RESOLVED。
**RESOLVED 仍阻断**（维修完成 ≠ 酒店验收通过）；COMPLETED / CANCELLED 不阻断。

## 12–15. 房态联动规则

- occupied 房间发生 blocking 维修：不允许 occupied → out_of_service；房间保持 occupied，
  工单独立阻断 Availability / Check-in（不破坏当前 Stay）。
- available 房间发生 blocking 维修：同事务 Room → out_of_service + source=MAINTENANCE；
  Cleaning 不变（out_of_service + clean / dirty 均可合法出现）。
- reserved / blocked / OOS(MANUAL) → 保留当前占用/来源（MANUAL 不得被改成 MAINTENANCE）。
- 已存在未来 CONFIRMED 预订 + 严重故障：允许创建 MWO，不自动取消/换房（安全优先）；
  /front-desk Attention 继续工作。

## 16–18. Availability / Check-in / Checkout 集成

- Availability 排除 active blocking MWO（无论 Room 当前 occupancy）。
- Check-in 纵深防御：cleaning clean + Room 非 blocked/OOS + **no active blocking MWO**，
  否则 409（后端最终权威）。
- Checkout：存在 active blocking MWO → Room = out_of_service + MAINTENANCE + dirty；
  否则 available + dirty；已 OOS(MANUAL) 保持停用与来源。HousekeepingTask 照常创建。
  退房事务（Stay + Reservation + Room + Housekeeping + Maintenance-aware + Audit）原子，
  任一步失败整体回滚。

## 19–23. 领域独立性 / 多工单 / Last Blocking / 只能解除自己的 OOS

- Housekeeping 与 Maintenance 独立并行（out_of_service + dirty + 双 IN_PROGRESS 合法）；
  Maintenance 不改 cleaning_status；Housekeeping 不解 maintenance blocking。
- Maintenance Complete ≠ Room Clean：verify 后 cleaning 保持原值。
- 同一 Room 允许多张 Active 工单（无 active-per-room 唯一约束）。
- verify / cancel 后重查同房 active blocking MWO：count == 0 且 Room = OOS 且
  source = MAINTENANCE 才恢复 available + null；MANUAL OOS / blocked 永不被解除。

## 24–26. Verify / Rework / Cancellation

- Verify：RESOLVED → COMPLETED（锁 Room → 锁 MWO；verified_at / verified_by /
  verification_notes；Last Blocking 判定；Audit；commit）。
- Rework：RESOLVED → IN_PROGRESS（记录返工原因）；blocks_room 继续阻断，不恢复 Room。
- Cancel：非终态 → CANCELLED；blocking 工单按 Last Blocking 规则恢复；
  非 blocking 工单 Room 无变化；需 `maintenance_order:cancel`。

## 27–28. 并发 / 回滚

- 锁顺序全项目一致：Room → MaintenanceWorkOrder（create blocking / verify / cancel /
  checkout 集成均先锁 Room）；Check-in Reservation → Room；Checkout Stay → Room。
- 并发仲裁错误沿用 Sprint 4 D1 窄分类：40P01 / 40001 → 409，其余 OperationalError 原样传播。
- 回滚：create 失败不残留孤儿 OOS；verify 审计失败保持 RESOLVED + OOS；
  cancel 中途失败保持先前状态；checkout housekeeping 失败整体回滚。

## 29–33. 审计 / PII / 权限 / Assignee / API

- 审计：maintenance.create / assign / start / resolve / verify / rework / cancel / update，
  含 Room become OOS / restore available 证据；后端自动，不依赖前端。
- PII：不关联 Guest / Reservation / Stay；不保存 Guest PII；维修人员无 Guest PII 出口。
- 权限（用 permission 判断）：maintenance_order:read / write / work / verify / cancel。
  SUPER_ADMIN / MANAGER 全量；FRONT_DESK / HOUSEKEEPING read+write；
  MAINTENANCE read+work；FINANCE 无。
- Assignee：`GET /maintenance/assignees`（maintenance_order:write 门控，
  返回持有 work 权限的在职用户；不扩大 user:read）。
- API（REST，/maintenance/orders）：

```text
GET  /maintenance/orders                    （status/room_id/category/severity/assigned_to/blocks_room/source + search: work_order_no/room_no/title + pagination）
POST /maintenance/orders
GET  /maintenance/orders/{id}
PATCH /maintenance/orders/{id}              （category/severity/title/description，strict）
POST /maintenance/orders/{id}/assign
POST /maintenance/orders/{id}/start
POST /maintenance/orders/{id}/resolve       （可选 resolution_notes）
POST /maintenance/orders/{id}/verify        （可选 verification_notes）
POST /maintenance/orders/{id}/rework        （可选 verification_notes）
POST /maintenance/orders/{id}/cancel
GET  /maintenance/assignees
```

## 34–39. UI / 集成 / PRE_OPENING

- `/maintenance`：轻量 Work Order Board（待处理/已派工/维修中/待验收/阻断客房/今日完成 +
  筛选：Room/Status/Severity/Category/Assignee/Blocks Room/Source + 搜索），不做企业级 Kanban。
- `/maintenance/[id]`：工单单号/房间/标题/描述/分类/严重度/阻断/来源/状态/报修人/负责人 +
  Room 双状态（后端内嵌）+ started/resolved/verified/completed 时间线；
  按 permission 显示 Assign/Start/Resolve/Verify/Rework/Cancel。
- Mobile：现场报修表单（Room/Category/Severity/Blocks Room?/Title/Description/Submit），
  支持 `?room_id=&source=` 预填。
- Housekeeping 集成：`/housekeeping/[id]` 「发现设施问题 → 报修」
  （仅 maintenance_order:write；预填 room_id + source=HOUSEKEEPING；不复制保洁备注）。
- Front Desk 集成：Room/Reservation Quick View 显示 active MWO + status + blocks_room +
  assignee + 查看维修（maintenance_order:read 才请求/显示）。
- PRE_OPENING：通过 source=PRE_OPENING 实现开业前 28 房整改清单，/maintenance 可筛选。

## 40–41. Out of Scope

不做：附件/照片/对象存储；Room Move；Guest Compensation；Incident Management；
Inventory/Spare Parts/Procurement；Preventive Maintenance；OTA/Payment/Invoice/Folio；
Revenue/Night Audit；CRM；AI。

## 测试基线（本 Sprint 目标）

- pytest：285（220 基线 + 65 新增）
- Vitest：285（240 基线 + 45 新增）
- Playwright：59（46 基线 + maintenance 2 spec 13 条）
- lint / typecheck / build：PASS
- Clean Bootstrap：empty stayops_test → alembic upgrade head → seed → FastAPI :8001 →
  Next.js :3001 → full Playwright（pytest 与 Playwright 不并行）

## Definition of Done

1. Maintenance Work Order 正式领域完成
2. Report → Assign → Start → Resolve → Verify/Rework → Complete 闭环
3. blocks_room 与 Severity 独立
4. Occupied Room 不被维修错误覆盖
5. Availability / Check-in 感知 Active Blocking Maintenance
6. Checkout 感知 Blocking Maintenance
7. Multiple Blocking Work Orders 正确
8. Maintenance 只能解除自己造成的 OOS
9. Cleaning 与 Maintenance 独立
10. Housekeeping / Front Desk 最小集成完成
11. PRE_OPENING 可实际使用
12. RBAC / PII / Audit 正确
13. Concurrency / Rollback 正确
14. Sprint 1–4 回归通过
15. pytest / Vitest / Playwright 全绿
16. Clean Bootstrap PASS
