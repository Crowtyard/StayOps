# StayOps Sprint 2 Task Specification（任务书总纲）

> Sprint 2 正式名称：**Booking & Stay Core Flow**（预订、入住与退房核心链路）
> 计划 Release：`v1.0.0-alpha.2`
>
> 本文档是 Sprint 2 三份任务书（S2-T1 / S2-T2 / S2-T3）的总纲。
> 由 DSH Agent 执行任务前必须完整阅读本文档 + 对应任务书，以及：
> `AGENTS.md`、`docs/PRD.md`、`docs/SPRINTS.md`、`docs/ARCHITECTURE.md`、`docs/DATABASE.md`、`docs/API.md`、`docs/DECISIONS.md`、`docs/ENVIRONMENT_CHECK.md`。
> 接口以 backend 当前 OpenAPI（`http://127.0.0.1:8000/openapi.json`）为唯一依据，禁止凭旧文档猜接口。

---

## 0. 当前项目状态（只读基线，2026-08-26 确认）

```text
Branch        = main
HEAD          = 9b3ba5e981cd3d534c15bd4a9af37f6f243c4723
Release       = v1.0.0-alpha.1（永不移位、不可改写）
Sprint 1      = FROZEN（Final Acceptance PASS）
Sprint 2      = APPROVED FOR TASK PLANNING
Coding        = NOT STARTED
DSH           = IDLE
Kun           = PROJECT MANAGER + QA
```

- 跟踪文件工作树干净。`git status` 若出现 `.kun-canvas/` 未跟踪目录，是 Kun GUI 画板状态目录，**不是项目工作内容，不得删除/提交/纳入任何任务范围**。
- 本次任务规划只允许修改 `docs/`；禁止修改 `backend/`、`frontend/`、`tests/`、`database/`、`package.json`、requirements、Docker 等。
- **本次规划不 Commit、不 Push、不创建 Tag、不创建 GitHub Release。**

## 1. Sprint 2 核心目标

一次完整住宿业务必须能真实跑通：

```text
Guest → Reservation → Availability → Room Assignment → Check-in → Stay → Check-out → Room = available + dirty
```

Sprint 2 完成后，StayOps 必须能够处理一次真实的预订、入住与退房业务，且并发、权限、审计全部正确。

## 2. Golden Path（最高优先级验收条件）

> 前台收到一笔微信预订，为张先生创建 2026-08-30 至 2026-09-01 的 203 房预订。
> 系统确认 203 在该日期区间可用。
> 第二个重叠预订尝试占用 203 时必须返回 `409 Conflict`。
> 客人到店后办理入住：Reservation → `CHECKED_IN`；创建 `ACTIVE` Stay；203 的 `occupancy_status` 自动变为 `occupied`。
> 客人退房后：Stay → `CHECKED_OUT`；Room → `available + dirty`；Audit Log 完整记录全过程。
> HOUSEKEEPING 可以看到房间 dirty，但**不能**获得 Guest 身份/联系方式与预订金额等数据。

任何阶段设计都必须服务这条主链。文中的 2026-08-30 → 2026-09-01 仅为业务故事示例，不得用于固定自动化测试。自动化测试（pytest / Vitest / Playwright）一律基于 Property Business Date（Asia/Shanghai，见 3.8）动态生成：Golden Path / Early Checkout 使用 `check_in_date = today`、`check_out_date = today + 2`，当天创建、当天入住、当天退房（REV-FINAL-03）；其余用例使用 today / today + N。禁止硬编码固定年月日，禁止依赖宿主机本地时区。

## 3. 不可违反的架构规则（Non-negotiable）

### 3.1 Reservation 与 Stay 分离
Reservation = 未来住宿计划；Stay = 实际入住事实。**不得合并为一个模型。**

### 3.2 Reservation 与 Room 当前房态解耦
创建未来 Reservation **不得**提前把 Room 的 `occupancy_status` 置为 `reserved`。
`occupancy_status` 只描述当前现场状态；未来可售性由 Reservation 日期区间判断。

### 3.3 日期区间语义
统一 `[check_in_date, check_out_date)`：包含入住日，不包含退房日。
- 允许：`8/30 → 9/1` 与 `9/1 → 9/3`（紧邻可衔接）
- 不允许：`8/30 → 9/1` 与 `8/31 → 9/2`（重叠）
- 校验：`check_out_date > check_in_date`（422）；日期为 DATE 类型，输入 `YYYY-MM-DD`。

### 3.4 Double Booking 必须并发安全
- 不得只依赖前端；不得只依赖应用层 `SELECT → 判断 → INSERT`。
- **数据库必须有最终竞态保护**：PostgreSQL `daterange + EXCLUDE USING gist`（需 `btree_gist` 扩展支持 `room_id =` 相等匹配）。排他约束只作用于仍占用日期区间的 `CONFIRMED` / `CHECKED_IN`（部分排他约束：`WHERE status NOT IN ('CANCELLED','NO_SHOW','COMPLETED')`，REV-01）；`CANCELLED` / `NO_SHOW` / `COMPLETED` 不再阻塞新预订。
- 两个并发请求抢同一 Room 同一日期：最终必须 **1 SUCCESS + 1 CONFLICT**，不得两个都成功。
- 应用层预检（availability check）只作为快速路径与友好报错；数据库约束是最终仲裁。约束冲突（pgcode `23P01`）必须映射为 409，不得泄漏为 500。

### 3.5 PII 最小权限原则
Guest 数据属于 PII。未经 `guest:read` 权限，**不得**通过 UI / API / Dashboard / Room Detail / Audit Log / Network Response 获取 Guest 身份与联系方式：`name`、`phone`、`email`、`notes`（Guest notes）。
Reservation 数据（`reservation_no`、日期、房号/房型、source、status、`agreed_total_amount`、`currency`、Reservation notes）由 `reservation:read` 控制，**不属于 Guest PII**（REV-02）；Sprint 2 不新增 `reservation:financial_read`。
后端必须是最终权限边界：响应模型按权限裁剪字段（不只是前端隐藏）。HOUSEKEEPING 同时缺少 `guest:read` 与 `reservation:read`，因此仍无法获得身份信息、联系方式与预订金额。

### 3.6 Check-in 必须事务化
单个数据库事务内完成：
```text
Reservation CONFIRMED → CHECKED_IN
+ Stay CREATE ACTIVE
+ Room occupancy_status → occupied
+ Audit Log
```
任一步失败 → 全部回滚。
日期资格（REV-FINAL-01，事务内校验）：仅当 `status = CONFIRMED` 且 `business_date ∈ [check_in_date, check_out_date)` 时允许 Check-in；未来预订提前入住 → 409；`business_date >= check_out_date` → 409。`business_date` 一律使用 Property Business Date（Asia/Shanghai，见 3.8）。客人提前到店时：先修改 Reservation 日期，再 Check-in。

### 3.7 Check-out 必须事务化
```text
Stay ACTIVE → CHECKED_OUT
+ Reservation CHECKED_IN → COMPLETED
+ Room occupancy_status → available
+ Room cleaning_status → dirty
+ Audit Log
```
必须是同一事务，任一步失败全部回滚。`CHECKED_IN → COMPLETED` 只能由 Stay Check-out 在该事务内触发，不得经任何 Update / Action API 手工触发（REV-01）。

### 3.8 Property Business Date（REV-FINAL-08）
统一业务日期口径：

```text
Property Timezone = Asia/Shanghai
business_date     = Asia/Shanghai 当前日期
```

所有业务日期判断统一使用 `business_date`：Check-in 资格、No-show 资格、Availability 的「今天」、Walk-in 默认 check_in_date、Dashboard Today、自动化测试。
禁止依赖宿主机本地时区（Windows / Linux）或数据库服务器 DATE，除非明确转换为 Asia/Shanghai。
时间戳（`actual_check_in_at` / `actual_check_out_at` / `created_at` / `updated_at`）一律 timezone-aware，默认取 Asia/Shanghai 当前时刻。
文档中不再使用「服务器当前日期/时间」表述。

## 4. 数据模型范围（Sprint 2 最小集合）

### Guest
`id, name, phone, email, notes, created_at, updated_at`
**不保存**：身份证号、身份证照片、人脸、公安住宿登记数据。

### Reservation
`id, reservation_no, guest_id, room_id, room_type_id, check_in_date, check_out_date, status, source, external_reference, agreed_total_amount, currency, notes, created_by, updated_by, created_at, updated_at`
- 金额用 `Numeric`（Decimal），JSON 序列化为字符串（沿用现有 `base_price` 约定）；**禁止 Float**。
- `reservation_no` 服务端生成、唯一（格式由 DSH 确定并记录 DECISIONS，如 `RSV20260830-0001`）。

### Stay
`id, stay_no, reservation_id, room_id, status, actual_check_in_at, planned_check_out_date, actual_check_out_at, created_by, updated_by, created_at, updated_at`
- **一个 Reservation 最多产生一个 Stay**（`reservation_id` 唯一约束 + 事务内状态校验双保险）。

## 5. 状态机（后端强制校验，非法 409）

### Reservation
```text
CONFIRMED
   ├── CANCELLED
   ├── NO_SHOW
   └── CHECKED_IN
          ↓（仅由 Stay Check-out 事务触发）
       COMPLETED
```
禁止：`CANCELLED → CHECKED_IN`、`NO_SHOW → CHECKED_IN`、`CHECKED_IN` 回退。
`CHECKED_IN → COMPLETED` 只能由 Stay Check-out 在同一数据库事务中触发，不得经普通 Reservation Update / Action API 手工触发（REV-01）。
`CONFIRMED → CHECKED_IN` 仅当 `business_date ∈ [check_in_date, check_out_date)`（REV-FINAL-01）。
`CONFIRMED → NO_SHOW` 仅当 `business_date >= check_in_date`；未来预订（business_date < check_in_date）调用 no-show → 409（REV-FINAL-02）。
状态只能经专用 action 端点变更（cancel / no-show / check-in），不得经 PATCH 直接改 status。

### Stay
```text
ACTIVE → CHECKED_OUT（终态，不得重新激活）
```
状态只能经 `POST /stays/{id}/check-out` 变更。

## 6. Availability Engine

正式可售性能力，输入：`check_in_date`、`check_out_date`、`room_type_id?`。
必须排除：
- 重叠的 CONFIRMED Reservation
- 重叠的 CHECKED_IN Reservation（`COMPLETED` 不再阻塞，REV-01）
- 重叠的 Active Stay（按其 `actual_check_in_at` 起、至 `planned_check_out_date` 止的区间）
- `blocked` 房间
- `out_of_service` 房间
- 查询区间包含当前业务日期（Property Business Date，Asia/Shanghai，见 3.8）时，当前 `occupied` / `reserved` 的房间

规则：
- 创建未来 Reservation **不要求** `cleaning_status = clean`。
- 真正 Check-in 当下**要求** `cleaning_status = clean`，否则 `409 Conflict`。
- 房间当前 `occupied` 但查询区间不包含今天时，只要无 Reservation/Stay 重叠即可售（未来可售性由日期区间判断，见 3.2）。

## 7. Reservation Source 与 Walk-in

Source 枚举：`DIRECT / PHONE / WECHAT / WALK_IN / OTA / CORPORATE / OTHER`。
Sprint 2 **不接任何 OTA API**；`external_reference` 仅用于人工记录外部订单号。

Walk-in **不做第二套流程**，统一：
```text
Reservation（source = WALK_IN，check_in_date = today）→ Check-in
```
`today` = Property Business Date（Asia/Shanghai，见 3.8）。

## 8. RBAC：新增权限与角色矩阵

新增权限码（Sprint 2）：

```text
guest:read         guest:write
reservation:read   reservation:write
reservation:cancel reservation:no_show
stay:read          stay:check_in      stay:check_out
```

角色矩阵（`✓` = 拥有；SUPER_ADMIN 动态拥有全部权限，沿用现有机制）：

| 权限 | SUPER_ADMIN | MANAGER | FRONT_DESK | HOUSEKEEPING | MAINTENANCE | FINANCE |
|---|---|---|---|---|---|---|
| guest:read / guest:write | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| reservation:read / reservation:write | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| reservation:cancel / reservation:no_show | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| stay:read / stay:check_in / stay:check_out | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |

- HOUSEKEEPING：不得拥有任何 Guest / Reservation / Stay 权限，只继续通过 Rooms / cleaning_status 工作（看到 dirty，看不到 PII）。
- MAINTENANCE：不获得 Guest / Reservation 权限。
- FINANCE：Sprint 2 不扩展 Booking 权限。
- 现有 17 个权限码语义不变；seed 保持幂等（沿用 `_sync_role_permissions` 精确同步策略）。
- 前端隐藏按钮**不是**权限控制；后端是最终权限边界。

## 9. API 范围（统一前缀 `/api/v1`）

```text
GET    /guests                    POST   /guests
GET    /guests/{id}               PATCH  /guests/{id}

GET    /availability

GET    /reservations              POST   /reservations
GET    /reservations/{id}         PATCH  /reservations/{id}
POST   /reservations/{id}/cancel
POST   /reservations/{id}/no-show
POST   /reservations/{id}/check-in

GET    /stays                     GET    /stays/{id}
POST   /stays/{id}/check-out
```

可根据现有 API 风格做轻微调整（分页、字段命名），**不得改变业务语义**。
- **Reservation 编辑（REV-FINAL-05）**：`status = CONFIRMED` 的 Reservation 允许经 PATCH 修改主要预订信息：`guest_id`、`room_id`、`room_type_id`、`check_in_date`、`check_out_date`、`source`、`external_reference`、`agreed_total_amount`、`currency`、`notes`。修改 `room_id` / `room_type_id` / `check_in_date` / `check_out_date` 必须重新执行 Availability Check + Double Booking Protection + Room / Room Type 一致性校验，数据库排他约束仍为最终仲裁。`CHECKED_IN` / `CANCELLED` / `NO_SHOW` / `COMPLETED` 不得经 PATCH 修改核心业务字段（409）。这是入住前的预订修改，不属于换房 / 延住工作流。
- **查询契约（REV-FINAL-07）**：`GET /guests` 支持 `search`（name OR phone）；`GET /reservations` 支持 `status / room_id / guest_id / room_type_id / source / check_in_date / check_out_date / search`（search 覆盖 reservation_no 与 Guest name/phone，Guest 搜索结果仍遵守 guest:read）；`GET /stays` 支持 `status / room_id / planned_check_out_date`。Dashboard 不新增聚合 API：今日到店 = CONFIRMED + check_in_date = today；今日离店 = ACTIVE Stay + planned_check_out_date = today；当前在住 = ACTIVE Stay；未来 7 天预订 = CONFIRMED + check_in_date ∈ [today, today+7)。Room Detail 优先组合 `GET /rooms/{id}` + `GET /stays?room_id=&status=ACTIVE` + `GET /reservations?room_id=`，不修改 Sprint 1 核心响应。
- 权限裁剪（REV-02 / REV-FINAL-04）：无 `guest:read` 时，所有响应不得包含 Guest 身份/联系方式（`name` / `phone` / `email` / Guest `notes`，含 `guest_name`）；无 `reservation:read` 时不得包含 Reservation 数据（含 `reservation_no`、日期、房号/房型、source、status、`agreed_total_amount`、currency）。两者皆缺（如 HOUSEKEEPING）则身份、联系方式与金额全部不可见。

## 10. Frontend 页面范围（S2-T2）

```text
/reservations        /reservations/new        /reservations/[id]        /stays/[id]
```
并扩展：`/dashboard`（今日到店 / 今日离店 / 当前在住 / 未来 7 天预订）、`/rooms/[id]`（当前 Stay、实际入住时间、计划离店日期、下一笔 Reservation；PII 按权限显示）。

## 11. 错误语义（沿用并扩展）

```text
401 = 未认证
403 = 已认证但无权限（含无 guest:read 访问 PII）
404 = 资源不存在
409 = 业务状态冲突
422 = 输入验证错误
```

409 至少适用于：Double Booking、Room unavailable、Dirty room Check-in、Occupied room Check-in、**Check-in 日期资格不符（business_date < check_in_date 或 >= check_out_date）**、**未来预订 No-show（business_date < check_in_date）**、Cancelled Reservation 后续操作、No-show Reservation 后续操作、Already Checked-out Stay、非法状态机转换、已 Check-in 的 Reservation 再次 Check-in、非 CONFIRMED 状态经 PATCH 修改核心字段。
422 至少适用于：输入验证错误、`reservation.room_type_id` 与 `room.room_type_id` 不一致（Room / Room Type 一致性，REV-FINAL-06；若 DSH 判断 409 更一致，须在 DECISIONS.md 记录原因）。

## 12. Audit Log

新增审计事件（沿用现有 `core/audit.py` 写入机制与 IP 采集）：

```text
guest.create        guest.update
reservation.create  reservation.update
reservation.cancel  reservation.no_show
reservation.check_in
stay.check_out
```

Audit details 允许记录 ID、状态变化摘要；**不得**无必要复制完整手机号、邮箱、Guest notes、完整金额数据。审计与业务变更同事务（见 3.6 / 3.7）。

## 13. 测试总要求与隔离规则

- **pytest**（backend，独立 `stayops_test` 库，沿用现有 conftest 策略：会话级 DROP/CREATE + `alembic upgrade head` + 幂等 seed，用例级事务回滚隔离）：基线 87 用例必须保持全绿；新增用例覆盖见各任务书。
- **Vitest**（frontend，jsdom + Testing Library）：基线 74 用例保持全绿。
- **Playwright E2E**（frontend，独立 `stayops_test` 库 + 8001/3001 端口 + `workers=1` 串行 + gitignored 凭据 `e2e/.env.test-creds`）：基线 10 用例保持全绿；**禁止 Mock FastAPI**，必须连接真实后端与真实测试数据库；**pytest 与 E2E 不得并行**（沿用现有互斥规则）。
- 测试数量合理变化必须解释原因；**不得静默删除测试制造 PASS**。
- 自动化测试日期一律基于 Asia/Shanghai 当前业务日期动态生成（today / today + N，REV-03），禁止硬编码固定年月日；文档中的 2026-08-30 → 2026-09-01 仅为业务示例。

## 14. Sprint 1 回归基线（必须全部保留）

```text
Login / HttpOnly Cookie / BFF / RBAC / Dashboard / Rooms / Room Detail /
Dual Room Status / Users / Roles / Room Types / Audit Logs / 401 / 403 /
Existing State Machines
```

基线计数：pytest **87**、Vitest **74**、Playwright **10**。

## 15. 已知非阻塞问题（Sprint 2 默认不修）

1. `/rooms/9999` 页面 HTTP 200 / BFF 404
2. Starlette/httpx TestClient warning
3. E2E 凭据需本地 gitignored 配置
4. `/health` 不包含 PostgreSQL readiness

除非实现直接触及相关模块，否则不得扩 Scope；如触碰，必须在完成报告中说明。

## 16. Out of Scope（严禁越界实现）

```text
OTA 自动同步（携程/美团/飞猪/Booking.com API）
公安住宿登记、身份证 OCR、人脸识别
门锁、支付、押金、退款、发票
CRM、会员、企业合同
多房订单、团队预订、换房、延住工作流、多人入住登记
动态房价、Revenue Management
保洁 Task、维修、库存、采购、Analytics、AI Manager
大型 PMS 日历
生产部署、CI/CD
```

## 17. 任务拆分与 QA 关卡

```text
S2-T1  Booking Domain Foundation（后端）→ 完成后必须停止，等 Kun 独立 QA，不得自动进入 T2
S2-T2  Booking Operations UI（前端）    → 完成后必须停止，等 Kun 独立 QA，不得自动进入 T3
S2-T3  Integration & E2E（全链路验收）  → 完成后停止，Kun 独立 QA + Final Acceptance
```

每阶段 QA PASS 后才允许进入下一阶段；`v1.0.0-alpha.2` 只在 **Sprint 2 Final Acceptance 全部 PASS** 后由 Kun 创建，DSH 永远不创建 Tag / Release。

## 18. Git 规则（Single Writer Principle）

- 真实开发只能由用户手动启动的 DSH Session 执行；Kun 不得创建修改 StayOps 工作区的后台 Coding Task。
- **DSH 不自行 Commit**（除非任务书明确要求；本 Sprint 无此要求）；每阶段完成后 Kun 独立 QA，QA PASS 后由 Kun 创建 Checkpoint。
- 不 Force Push；不重写 Sprint 1 历史；`v1.0.0-alpha.1` 永不移位。

## 19. DSH 完成报告模板（每个任务必交）

按 AGENTS.md 报告模板扩展：

```text
1. 修改文件（新增/修改/删除，逐条列出）
2. 主要实现（按本任务书各章节对应说明）
3. 数据库变化（新表/枚举/约束/索引/迁移版本号；升级与降级验证）
4. API 变化（端点、权限、错误码、响应模型；与 OpenAPI 一致性）
5. RBAC 变化（新增权限码、角色映射、seed 幂等验证）
6. 审计事件（新增 action 列表、details 脱敏验证）
7. 测试命令与结果（逐条命令 + 通过数；基线 87/74/10 是否保持；新增用例数；数量变化原因）
8. Golden Path 证据（API 层或 E2E 的完整链路输出）
9. 并发与事务证据（Double Booking / 并发 Check-in / 并发 Check-out 均 1 SUCCESS + 1 CONFLICT；Check-in/out 回滚验证）
10. 权限证据（无 guest:read 角色各出口无 name/phone/email/Guest notes；无 reservation:read 角色无 reservation_no/日期/金额等 Reservation 数据）
11. DoD 清单逐项打勾
12. 已知问题（含触碰的 Known Issue 说明）
```

## 20. 自检问题对照（任务书必须回答）

1. DSH T1 到底做什么？→ S2-T1.md：预订域后端全套（模型/迁移/Availability/并发保护/状态机/RBAC/审计/API/pytest）。
2. DSH T1 明确不做什么？→ 不写前端、不接 OTA/支付/公安/门锁等 Out of Scope、不改 Sprint 1 语义、不 Commit。
3. T1 怎样证明完成？→ DoD 清单 + pytest 全绿（87 基线 + 新增）+ Golden Path API 级证据 + 并发/PII/回滚证据 + 完成报告。
4. QA 怎样独立验收？→ 每任务后 DSH 停止；Kun 独立审阅 diff、重跑全部测试、复验 Golden Path 与并发/PII/回滚，PASS 后建 Checkpoint。
5. T2 怎样建立 UI？→ 在现有 App Router + BFF + 统一 API Client 之上新增 reservations/stays 页面与 dashboard/room detail 扩展，Vitest 覆盖。
6. T3 怎样跑真实 Golden Path？→ Playwright 连接真实 FastAPI + 独立测试库，动态日期（check_in = today、check_out = today+2）完整走 预订→重叠 409→当天入住→当天退房→Reservation COMPLETED + available+dirty→审计→PII 校验。
7. 如何防 Double Booking？→ 数据库 `daterange + EXCLUDE USING gist`（部分约束，只作用于 CONFIRMED/CHECKED_IN，排除 CANCELLED/NO_SHOW/COMPLETED）+ 应用层预检，并发最终 1 SUCCESS 1 CONFLICT。
8. 如何保证并发安全？→ 数据库排他约束为最终仲裁；Check-in/Check-out 由事务 + 状态校验 + 唯一约束（reservation_id）保证；并发测试验证（Double Booking / 并发 Check-in / 并发 Check-out，REV-FINAL-08）。
9. 如何保证 Check-in / Check-out 原子性？→ 单事务多步操作（Check-out 含 Stay→CHECKED_OUT、Reservation→COMPLETED、Room→available+dirty、Audit），任一步失败全部回滚，pytest 显式回滚用例验证。
10. HOUSEKEEPING 为什么看不到 PII？→ 无 guest:read（Guest 身份/联系方式）且无 reservation:read（Reservation 数据/金额）；后端响应模型按权限裁剪字段（name/phone/email/notes/amount 等不出现于任何出口），前端再按权限渲染。
11. Sprint 1 如何回归？→ 基线 87/74/10 全量保留并全绿；既有功能清单（§14）逐项保留；不得删测试。
12. Sprint 2 什么时候才允许创建 alpha.2？→ Sprint 2 Final Acceptance 全部 PASS 后，由 Kun 创建；DSH 不创建 Tag/Release。
