# StayOps 架构

## 顶层架构

- `frontend/` — Next.js 16 + TypeScript（strict）+ Tailwind 前端
- `backend/` — FastAPI + Python 后端
- `infra/docker/` — Docker 部署配置
- `docs/` — 项目文档
- `tests/` — 测试

## Local Runtime（Alpha.5 加固）

- `start-dev.cmd` + `scripts/dev_runtime.py`（仅 Python 标准库，不要求 PowerShell）为统一本地开发入口：
  Git 预检 → 端口安全（8000/3000 占用即 FAIL FAST，显示 PID，不杀未知进程）→
  开发库 `stayops` 的 `alembic current == heads` 检查（默认 CHECK ONLY，`--migrate` 才升级）→
  Backend（`.venv` uvicorn `--reload`，127.0.0.1:8000）→ Frontend（`pnpm.cmd dev`）→
  就绪校验（`/health` + `/openapi.json` 核心路由 Rooms/Reservations/Housekeeping/Maintenance +
  `/login`；Frontend 失败显式关闭 Backend，不留半套环境）→ 运行摘要。
  `Ctrl+C` 同时关闭前后端进程树；`--check` 只检查不启动。
  生产部署方式（infra/docker）不受影响。

## 后端结构（Sprint 8 · 更新）

```text
backend/app/
  models/            # Guest / Reservation / Stay（Booking 域）
                     # StayRoomAssignment 新增（Sprint 6：在住房间分配历史 + room_move_reason 枚举）
                     # HousekeepingTask（Sprint 3：任务/枚举/来源/优先级；Sprint 6 增加 ROOM_MOVE 来源）
                     # MaintenanceWorkOrder（Sprint 5：工单/枚举/阻断语义）
                     # Sprint 7：inventory.py（InventoryItem / InventoryLocation /
                     #   InventoryBalance Projection / StockMovement 不可变账本 /
                     #   StockIssue+Lines）与 procurement.py（Supplier /
                     #   PurchaseRequest+Lines / PurchaseOrder+Lines /
                     #   GoodsReceipt+Lines）
  core/              # Sprint 8 新增 analytics_metrics.py（Metric Dictionary
                     #   集中定义：code/中文名/公式/来源表/状态/单位/零分母行为/权限，
                     #   docs/ANALYTICS.md 的代码镜像）
  schemas/           # guest / reservation / stay（Sprint 6：assignments / RoomMoveCreate /
                     # RoomMoveOptionsOut）
                     # housekeeping（Create/Update strict、AssigneeOut）
                     # maintenance（Create/Update strict、Assign/Resolve/Verify/Rework、AssigneeOut）
                     # Sprint 7：inventory / procurement（strict extra=forbid、
                     #   quantity/金额 Decimal 字符串序列化、状态机专用 action schema）
  core/              # business_date.py（Property Business Date，Asia/Shanghai）
                     # booking_state_machine.py（Reservation / Stay 状态机）
                     # housekeeping_state_machine.py（Task 状态机 + 房态联动映射）
                     # maintenance_state_machine.py（MWO 状态机 + BLOCKING 语义）
                     # db_conflict.py（23P01/40P01/40001 并发仲裁窄分类，Sprint 4 D1 复用；
                     #   Sprint 7 增加 classify() SQLSTATE 分类）
  services/booking.py    # 可售性引擎、预订生命周期、Check-in/Check-out 事务、
                         # 权限裁剪序列化；Sprint 6：CONFIRMED-only 可售性、
                         # Room Row Lock（lock_room_for_update / lock_rooms_for_update）、
                         # room_release_state（S5 释放决策抽取，退房/换房共用）、
                         # Check-in 建立 assignment #1 / Checkout 关闭 open assignment
  services/room_move.py  # 新增：目标房资格评估 + room-move-options + 原子换房事务
                         # （Stay → Rooms(pk 升序) 锁顺序、事务内重校验、
                         #  source release + ROOM_MOVE 保洁任务 + stay.room_move 审计）
  services/housekeeping.py # 任务生命周期、Task↔Room 原子联动；Sprint 6：_create_auto_task
                         # 抽取（CHECKOUT / ROOM_MOVE 共用）
  services/maintenance.py  # 工单生命周期、blocks_room ↔ Room 可售性原子联动（Room → MWO 锁顺序）
  services/inventory.py    # Sprint 7：库存账本核心——业务单号（SMV/SIS Sequence）、
                           # Balance 锁定（(item_id,location_id) 升序 +
                           #   INSERT ON CONFLICT + FOR UPDATE）、
                           # _record_movement（流水+余额同事务原子，no movement = no stock change）、
                           # create_item / update_item / update_location、set_initial_stock（INITIAL）、
                           # create_issue（多行全原子）/ create_return / create_transfer
                           #   （OUT↔IN 成对互指）/ create_stocktake（差异→ADJUSTMENT）、
                           # total_stock_by_item / stock_status_for / recommended_replenishment
  services/procurement.py  # Sprint 7：采购闭环——create/update supplier、PR 状态机
                           # （submit/approve/reject/cancel，行锁 + 专用 action）、
                           # create_order（Request→PO 同事务 exactly-once）、
                           # mark_ordered / cancel_order（PO 不改变库存）、
                           # receive_goods（收货事务：PO→lines→Balances 锁链、
                           #   PURCHASE_RECEIPT 流水 + PO 状态推导）
  api/routes/        # guests / availability / reservations / stays（Sprint 6：
                     # room-move-options / room-move 端点）
                     # housekeeping（/housekeeping/tasks + /housekeeping/assignees）
                     # maintenance（/maintenance/orders + /maintenance/assignees）
                     # reservations 列表 overlap_from / overlap_to（Sprint 4）
                     # Sprint 7：inventory（/inventory/items|locations|balances|movements
                     #   + issues|returns|transfers|stocktakes 业务动作）与 procurement
                     #   （/procurement/suppliers|requests|orders + 状态机 action 端点）
  alembic/versions/c8e2b7a4d1f3_add_room_move_domain.py  # 新增：Room Move 域迁移
                     # （stay_room_assignments 表/枚举/CHECK/部分唯一索引/排他约束、
                     #   hk_task_source + ROOM_MOVE、Reservation 排他约束 CONFIRMED-only、
                     #   既有 Stay 历史回填）
  alembic/versions/e3a91f5c8d24_add_inventory_procurement_domain.py  # Sprint 7 新增：
                     # Inventory + Procurement 域迁移（13 张表、5 个 PG 枚举、
                     #   5 个业务单号 Sequence、UNIQUE(item,location)、
                     #   movement 符号 CHECK、received<=ordered CHECK、
                     #   PR→PO 一对一 UNIQUE）
```

- 预订域业务集中在 `services/booking.py`（routes 保持薄），决策见 docs/DECISIONS.md（S2-T1 第 9 条）。
- Double Booking 最终仲裁在数据库（排他约束 `ex_reservations_room_daterange`，**Sprint 6 起 CONFIRMED-only**）+ Room Row Lock 事务内重校验；应用层预检仅为快速路径。
- Active Task 唯一最终仲裁在数据库（部分唯一索引 `uq_housekeeping_tasks_active_room`），应用层预检仅为快速路径。
- Stay 当前房间唯一性最终仲裁：Stay 行锁 + 目标房行锁 + 事务内重校验 + 部分唯一索引 `uq_stay_room_assignments_active_stay` / 排他约束 `ex_stay_room_assignments_no_overlap`（Sprint 6）。
- Check-out / Room Move 与 Housekeeping Task 创建为同一数据库事务（原子不变式：离房必有翻房任务）。
- 后端是 PII / 权限的最终边界：响应按 guest:read / reservation:read 裁剪字段（不只是前端隐藏）。Housekeeping / Maintenance 域不关联 Guest / Reservation，天然无 PII。
- **Sprint 6 Room Move**：Reservation = 未来商业分配（Check-in 后 room_id 冻结为原分配房）；
  Stay = 实际住宿（room_id = 当前实际房间快速指针）；StayRoomAssignment = 实际房间历史
  （ended_at NULL = active assignment）。原子换房事务锁顺序 Stay → Rooms（Room pk 升序），
  与 Checkout（Stay → Room）、Check-in / Reservation update（Reservation → Room）、
  Maintenance（Room → MWO）全局无环；目标房资格后端权威（available+clean+无阻断维修+
  无其它 ACTIVE Stay+剩余区间 [move_date, planned_check_out) 无 CONFIRMED 预订）；
  换房绝不触碰原房 MWO 生命周期（维修独立性）。
- **Maintenance（Sprint 5）**：MaintenanceWorkOrder 为第三独立业务领域（维修状态 ≠ 占用 ≠ 清洁）；
  Active Blocking（blocks_room + OPEN/ASSIGNED/IN_PROGRESS/RESOLVED）参与 Availability /
  Check-in / Checkout / Room Move 目标资格最终判断；工单 ↔ Room 可售性事务固定锁顺序 Room → MWO；
  只能解除自己造成的 OOS（source=MAINTENANCE 且 active blocking MWO=0），
  MANUAL OOS / blocked 永不被 Maintenance 解除；Cleaning 维度不受 Maintenance 影响。
  Maintenance 域不关联 Guest / Reservation，天然无 PII。
- **Inventory & Procurement（Sprint 7，第二条运营链：库存与采购）**：
  StockMovement = 永久库存账本事实（immutable ledger，无 PATCH/DELETE 端点）；
  InventoryBalance = 快速查询 Projection（唯一 (item_id, location_id)），
  每次库存事务与流水同事务更新（no movement = no stock change）。
  锁顺序：Inventory 事务只锁 Balance 行（(item_id, location_id) 升序）；
  Procurement 收货 = PurchaseOrder → PO lines → Balance 行（Balance 永远在
  锁链末端，与 S5/S6 锁图全局无环）。PO 不改变库存；只有 Goods Receipt 创建
  PURCHASE_RECEIPT 流水并增加库存（收货才是 stock-in 权威）；部分收货
  cumulative received <= ordered（行锁 + DB CHECK）。PR 状态机
  DRAFT→SUBMITTED→APPROVED→ORDERED、PO 状态机
  DRAFT→ORDERED→PARTIALLY_RECEIVED→RECEIVED，状态只能经专用 action 端点变更；
  Request→PO 同事务 exactly-once（行锁 + UNIQUE）。无自动客耗扣账（Checkout /
  Housekeeping / Room Move 不扣库存）。低库存：total==0 → OUT_OF_STOCK，
  total<=minimum → LOW_STOCK；建议补货 = max(target-total, 0)，仅建议不自动下单。

## 通信架构：HttpOnly Cookie + BFF

浏览器不接触 JWT。前端所有后端调用统一经过 Next.js Route Handler：

```text
Browser ──→ /api/auth/login|logout|me（认证 BFF，读写 HttpOnly Cookie）
        └─→ /api/bff/[...path]（通用代理，服务端读 Cookie 附加 Bearer）
              └─→ FastAPI /api/v1/*（BACKEND_API_URL，业务权限唯一裁决点）
```

- 登录成功 → JWT 写入 `stayops_token` Cookie（httpOnly / sameSite=lax / path=/；生产 secure）
- 401 前端清状态跳 /login；403 显示“无权限”，不与登录失效混淆
- 服务端直连后端（Server Components 登录守卫 / 认证 BFF）时不经过 `/api/bff`

## 前端结构（T3b / S2-T2 / S3）

```text
frontend/src/
  app/
    api/auth/{login,logout,me}/route.ts   # 认证 BFF（Cookie 读写）
    api/bff/[...path]/route.ts            # 通用代理（透传状态码与 detail）
    login/page.tsx                        # 登录页
    (main)/layout.tsx                     # 受保护布局：服务端登录守卫 + AppShell
    (main)/dashboard|rooms|rooms/[id]     # 首页概览 / 房态棋盘 / 房间详情
    (main)/reservations                   # S2-T2：预订列表（筛选/分页）
    (main)/reservations/new               # S2-T2：新建预订（Guest 搜索创建 + Availability）
    (main)/reservations/[id]              # S2-T2：预订详情（编辑/Cancel/No-show/Check-in）
    (main)/stays                          # S2-T2：在住列表（stay:read 导航落点）
    (main)/stays/[id]                     # S2-T2：在住详情（Check-out；Sprint 6：换房 + 房间记录 +
                                          #   原分配房/当前在住房）
    (main)/housekeeping                   # S3：保洁运营工作台（状态视图 + 快捷操作 + 新建任务）
    (main)/housekeeping/[id]              # S3：保洁任务详情（派单/优先级/备注 + 操作确认）
    (main)/maintenance                    # S5：维修运营工作台（状态视图 + 筛选/搜索 + 快捷操作 + 现场报修）
    (main)/maintenance/[id]               # S5：维修工单详情（派工/编辑 + 六个 action 确认）
    (main)/maintenance/new                # S5：现场报修表单（Mobile Friendly，?room_id&source 预填）
    (main)/inventory                      # S7：库存工作台（统计 + 物资表格 + 筛选 + 领用/调拨/盘点/新建 Modal）
    (main)/inventory/items/[id]           # S7：物资详情（信息 + 总/最低/目标/建议补货 + 地点余额 + 最近流水）
    (main)/procurement                    # S7：采购工作台（低库存建议/待审批/已批准待转单/待收货/部分收货）
    (main)/procurement/suppliers          # S7：供应商管理（新建/编辑/停用）
    (main)/procurement/requests           # S7：采购申请列表 + 新建（多行）
    (main)/procurement/requests/[id]      # S7：申请详情（提交/批准/驳回/取消/转订单，按 status + 权限）
    (main)/procurement/orders             # S7：采购订单列表 + 新建（由申请转单 / 直接创建）
    (main)/procurement/orders/[id]        # S7：订单详情（ordered/received/remaining/单价/金额 +
                                          #   收货记录 + 下达/收货（部分收货）/取消剩余）
    (main)/analytics                      # S8：经营分析管理驾驶舱（四 Tab + 统一 Date Selector）
    (main)/front-desk                     # S4：前台运营指挥台（Today Summary + Search + Room Diary + 右侧 Drawer）
    (main)/settings/{users,roles,room-types,audit-logs}/page.tsx   # 管理页（T3b）
  components/                             # AppShell(侧边导航+顶栏+手机Drawer)、状态徽标、
                                          # 确认对话框、Modal、Loading/Empty/Error/Forbidden 视图
  components/booking/                     # S2-T2：guest-picker（搜索/创建）、availability-picker（可售房间）、
                                          # reservation-form（新建/编辑共用，S4 增加 create 模式 prefill）、shared（字段/提示条）
                                          # room-move-dialog（Sprint 6 新增：可复用换房对话框，
                                          #   目标房由 room-move-options 后端权威驱动 + 显式确认换房）
  components/front-desk/                  # S4：front-desk-view（指挥台编排 + 权限门控 + 轮询）、
                                          # use-front-desk-data（4 个批量 List API 组合，无 N+1）、
                                          # room-diary（时间线网格 + sticky 房间栏 + 空白格快捷菜单；
                                          #   Sprint 6：ACTIVE Stay 在住条 = 当前实际占用）、
                                          # today-summary / search-box / drawer / drawer-views
                                          # （Arrivals/Departures/Attention/Reservation/Room Quick View；
                                          #   Sprint 6：In-house [换房] 入口 + 在住换房抽屉视图 +
                                          #   Reservation 抽屉「当前在住房」）、
                                          # front-desk-today-board（<768px 移动端；Sprint 6 在住换房入口）
  components/housekeeping-*.tsx           # S3：工作台视图 / 任务详情视图
  components/maintenance/                 # S5：maintenance-workspace-view（工作台）、
                                          # maintenance-work-order-detail-view（详情）、report-form（现场报修）
  components/inventory/                   # S7：inventory-workspace-view（工作台）、
                                          # inventory-item-detail-view（详情 + 期初/编辑 Modal）、
                                          # create-item-form / issue-form / transfer-form / stocktake-form
  components/procurement/                 # S7：procurement-workbench-view（工作台）、suppliers-view、
                                          # requests-view（+ CreateRequestModal）、request-detail-view
                                          # （+ ConvertToOrderModal）、orders-view（+ CreateOrderModal）、
                                          # order-detail-view（+ ReceiveGoodsModal 部分收货）
  components/analytics/                   # S8：analytics-view（四 Tab 编排 + 权限域门控 + 日期状态）、
                                          # date-selector（预设/自定义/对比开关）、overview-tab /
                                          # rooms-bookings-tab / operations-tab / inventory-procurement-tab、
                                          # kpi-card（值 + pp/percent 变化）、charts（极简 SVG 折线/柱状，
                                          #   npm registry 不可达未引入图表库）、shared（SectionCard/TextTable）
  components/settings/                    # 四个管理页视图 + 共享工具（分页加载/表单/表格）
  lib/api/                                # 统一 API Client（client.ts + guests/reservations/stays（Sprint 6：
                                          # roomMoveOptions / roomMove）/ availability + housekeeping（S3）+
                                          # maintenance（S5）+ inventory / procurement（S7）+ analytics（S8，
                                          #   operations/business/forecast 端点）等资源模块 + 错误归一化）
  lib/booking.ts                          # S2-T2：业务日期（Asia/Shanghai）、日期校验、状态标签、金额展示
  lib/front-desk.ts                       # S4：时间线几何（[ci,co) 裁剪与像素定位）、Today Summary /
                                          # Attention 四规则纯函数（A/B/C/M）、预订条 PII 安全文案、quickCreateHref；
                                          # Sprint 6：TIMELINE_STATUSES = CONFIRMED only + ACTIVE Stay 在住条
                                          # （stayCheckInDate / stayBarText / stayBarTitle）
  lib/room-move.ts                        # S6 新增：换房原因元数据（7 固定枚举）、assignment 历史格式化、
                                          # 原分配房 vs 当前在住房判断（展示层）
  lib/housekeeping.ts                     # S3：任务状态/优先级/来源展示元数据 + 房态联动映射（展示层）；
                                          # S6：HK_SOURCE_LABELS 增加 ROOM_MOVE「换房自动」
  lib/maintenance.ts                      # S5：工单状态/分类/严重度/来源展示元数据 + Active Blocking 判断（展示层）
  lib/inventory.ts                        # S7：分类/流水类型/领用目的地/库存状态展示元数据 +
                                          # computeStockStatus / recommendedReplenishment / qty / fmtQty（展示层）
  lib/procurement.ts                      # S7：PR / PO 状态展示元数据（展示层，不复制后端状态机）
  lib/server/                             # 服务端 Cookie 读取 / 后端直连 Client
  test/setup.ts                           # Vitest 全局 setup（jest-dom + RTL cleanup）
```

- 页面数据由 Client Component 在挂载后经 `/api/bff` 拉取（Loading/Empty/Error 三态）；
  登录态由服务端布局读取 Cookie 校验（未登录 307 → /login）
- 导航按 `auth/me` 返回的权限 code 动态显示（S2-T2：`reservation:read` → 预订、`stay:read` → 在住；
  S3：`housekeeping_task:read` → 保洁；S4：`room:read` + `reservation:read` 同时满足 → 前台；
  S5：`maintenance_order:read` → 维修）；
  403 统一渲染“无权限访问该页面”（不跳登录，与 401 区分）
- 管理页写操作权限（user:write / role:write / room_type:write 等）由后端 RBAC 裁决，前端仅按权限显隐按钮
- Booking 操作（cancel / no-show / check-in / check-out）按 Reservation.status 值 + 权限显隐按钮，前端不复制后端状态机；后端 409 detail 原样展示
- PII 双边界：后端响应已按 guest:read / reservation:read 裁剪（裁剪字段以键缺失呈现，见 S2-T1），前端再按权限隐藏对应区块（不渲染 Guest 姓名/联系方式/金额）
- Housekeeping 操作（start / submit / pass / rework / cancel）按 Task.status 值 + 权限显隐按钮，
  前端不复制后端状态机；派单候选人经 `GET /housekeeping/assignees`（housekeeping_task:write，
  不要求 user:read）；任务页面不含任何 Guest / Reservation 数据
- **Maintenance（S5）**：操作（assign / start / resolve / verify / rework / cancel）按
  MWO.status 值 + 权限显隐按钮，前端不复制后端状态机；工单页面不含任何 Guest / Reservation 数据；
  报修表单 Mobile Friendly 并支持 `?room_id&source` 预填；保洁任务详情「发现设施问题 → 报修」
  仅 `maintenance_order:write` 时显示（预填 room_id + source=HOUSEKEEPING，不复制保洁备注）；
  Front Desk Room/Reservation Quick View 展示 Active MWO + status + blocks_room + assignee
  + 查看维修（`maintenance_order:read` 才请求与展示）
  - Front Desk（S5 修复）：Attention 新增 Rule M「预订存在维修风险」
    （CONFIRMED + check_in ≥ 今日 + Active Blocking MWO，与 Room occupancy 无关；
    一条预订一条卡片、多工单合并计数；M 优先抑制同预订 Rule C；仅
    maintenance_order:read 时加载 workOrders，无权限不请求不显示）；
    桌面 Attention Drawer 与 Mobile Today Board 共享 computeAttention 并渲染
    「查看维修 →」直达链接
- **Front Desk（S4 + S5 最小集成）**：页面数据 = `GET /rooms` + `GET /reservations?overlap_from&overlap_to`
  + `GET /stays?status=ACTIVE` + `GET /housekeeping/tasks` + `GET /maintenance/orders`
  （S5，仅 `maintenance_order:read` 时请求）批量 List API 客户端组合
  （无 N+1，无聚合端点）；时间线严格 `[check_in, check_out)` 渲染，双状态（占用 + 清洁）不合并；
  空白格快速新建复用 `/reservations/new`（URL 预填），Backend Availability 仍重新验证；
  写操作后 targeted refetch + 60s 轻量轮询（Drawer 打开时暂停）；
  <768px 渲染 FrontDeskTodayBoard（不渲染完整 Room Diary），768–1023 紧凑、≥1024 完整
- **Front Desk（Sprint 6 Room Diary 语义升级）**：Future booking = CONFIRMED
  Reservation.room_id（预订条）；Current actual occupancy = ACTIVE Stay.room_id
  （在住条 [actual check-in 日, planned_check_out)，点击进 Stay 详情）；
  CHECKED_IN 预订不再画成当前实际占用；换房后 Stay 条画在新房、旧房显示其
  当前 dirty / maintenance-OOS 状态；In-house 抽屉与移动 Today Board 提供
  [换房] 入口（stay:room_move 显隐，后端 403 兜底）。

## 测试架构（T3b / S2-T2）

- **Vitest 单元/组件测试**（`frontend/vitest.config.mts`，jsdom + @testing-library/react，`pnpm test`）：
  测试文件与源码同目录（`src/**/__tests__/*.test.ts(x)`）；API 层经 `vi.mock` 替换为假实现、
  真实 `ApiError` 语义保留；`next/navigation` / `next/link` 按需 mock。
  S2-T2 新增 Booking 域用例（139 = Sprint 1 基线 74 + S2-T2 新增 65），
  S3 新增 Housekeeping 域用例（170 = 139 + 31：lib 元数据 / 工作台 / 任务详情 /
  导航 / Dashboard 概览 / Room Detail 任务卡），
  S4 新增 Front Desk 用例（240 = 170 + 70：lib 时间线几何与三规则 / Room Diary /
  Command Center 集成 / Today Board / 快速新建预填 / 前台导航矩阵），
   S5 新增 Maintenance 用例（300 = 240 + 60：lib 元数据 / 维修工作台 / 工单详情 /
   现场报修表单 / 保洁快捷报修 / 前台维修集成 / 维修导航矩阵），
   S6 新增 Room Move 用例（324 = 300 + 24：lib 换房元数据 / 历史格式化 / 在住条几何 /
   Stay 详情换房对话框 / Front Desk 换房入口与抽屉 / Room Diary 在住条语义更新 /
   HK 来源 ROOM_MOVE），
   S7 新增 Inventory/Procurement 用例（379 = 324 + 55：lib 库存状态计算与元数据 5 /
   导航矩阵 4 / 库存工作台 7 / 领用·调拨·盘点表单 9 / 物资详情 5 / 采购工作台 4 /
   采购申请·订单视图（含部分收货）11 / Dashboard 权限门控 5），
   S8 新增 Analytics 用例（414 = 379 + 35：lib 格式化/零值/pp/percent/日期预设/
   自定义校验 21 / AnalyticsView 权限门控·零数据·日期交互 8 / 四 Tab 渲染 6），
   S8 QA 修复新增 5（419 = 414 + 5：preset → comparison_mode 映射 3 /
   视图按 preset 发送模式 2），
  测试日期一律基于 Asia/Shanghai 业务日期动态生成（`businessDate()` / `addDays`，禁止硬编码年月日）。
- **Playwright E2E**（`frontend/playwright.config.ts`，`pnpm test:e2e`）：
  - 独立测试库 `stayops_test`：后端 webServer 直接运行单进程入口 `frontend/e2e/run_test_backend.py` ——
    `prepare_test_db.py` DROP/CREATE 测试库 → alembic upgrade → 幂等 seed（28 间种子房）→
    在本进程内于 `127.0.0.1:8001` 启动 FastAPI（`DATABASE_URL` 指向测试库）
  - E2E 前端：`node node_modules/next/dist/bin/next dev -p 3001`（`BACKEND_API_URL=http://127.0.0.1:8001`，`NEXT_DIST_DIR=.next-e2e` 独立构建目录）
  - `setup-users.ts` 在测试 `beforeAll` 中以 admin 直连后端创建 FRONT_DESK / HOUSEKEEPING 测试账号（幂等）
  - 凭据仅存 gitignored 的 `frontend/e2e/.env.test-creds`（模板 `test-creds.example`），经环境变量注入 worker
  - 单 worker 串行执行保证共享测试库确定性；不触碰开发环境（127.0.0.1:8000 / localhost:3000）
  - S2-T3 新增 7 个 spec（辅助集中在 `e2e/booking-helpers.ts`，动态日期 = Asia/Shanghai）：
    `golden-path`（预订 → 重叠 409 → 当天入住/退房 → 审计无 PII，房间 203）、
    `early-checkout`（REV-FINAL-03：COMPLETED 释放剩余日期，房间 204）、
    `booking-rbac`（SUPER_ADMIN / FRONT_DESK / HOUSEKEEPING 导航与 403）、
    `booking-pii`（HOUSEKEEPING 三层无 PII：UI / 网络响应 / 直连 403，房间 201）、
    `concurrency`（Double Booking / 并发 Check-in / 并发 Check-out 各 1 SUCCESS + 1 × 409，
    两个独立 APIRequestContext + Promise.all，房间 301-303）、
    `failures`（dirty/occupied/未来入住/已取消/已退房 409 + 404/401 语义，房间 304-308）、
    `regression`（Sprint 1 补充冒烟，房间 103；与既有 10 条互补，不替代）
  - S3 新增 2 个 spec（辅助集中在 `e2e/housekeeping-helpers.ts`）：
    `housekeeping`（翻房 Golden Path UI 全链路 + 下一笔入住成功，房间 210；
    Rework 闭环每步房态一致，房间 209；手动任务/重复 409/admin 取消，房间 109）、
    `housekeeping-safety`（Check-in clean gating 四状态 409 + clean 成功，房间 105-109；
    RBAC 矩阵 + assignees；Duplicate Active Task / Concurrent Start / PASS vs REWORK 并发；
    PII 无泄漏）
  - S4 新增 `front-desk.spec.ts` 10 条（辅助集中在 `e2e/front-desk-helpers.ts`，
    超期在住状态准备 `e2e/setup_overdue_stay.py`，房间 110/202/206/207/208）：
    28 房 Diary + Today Summary；Golden Path（空白格快速新建 → [ci,co) 时间线区间 →
    Drawer → Check-in → 刷新 → Check-out → dirty + 保洁任务）；相邻预订首尾相接
    （boundingBox 实测 1 晚 = 64px、gap ≤ 2px）；Attention 三规则 + 维修风险（脏房到店 / 超期在住 /
    停用房未来预订）；Housekeeping 集成（脏房到店 → 任务可见 → 完成清扫 → 刷新 clean →
    Check-in 成功）；搜索定位（房号 / 预订单号）；PII（无 guest:read 姓名隐藏 + 搜索受限）；
    RBAC（HOUSEKEEPING / FINANCE 无入口 + 直连 403）；Mobile（390×844 Today Board，
    Room Diary 不渲染）；Tablet（900×720 紧凑 Diary）
  - S5 新增 `maintenance.spec.ts` 3 条 + `maintenance-safety.spec.ts` 11 条
    （辅助集中在 `e2e/maintenance-helpers.ts`，账号 MANAGER / MAINTENANCE 由
    `setup-users.ts` 幂等创建，房间 301-308 测试开始前经 admin API 归一化）：
    Golden Path UI 全链路（保洁发现 → 阻断报修 → MANAGER 派工 → MAINTENANCE 维修 →
    MANAGER 验收 → 房间恢复 → 清洁后 Check-in Ready + 全链路审计）；PRE_OPENING
    报修与来源筛选；Mobile 390×844 报修表单；occupied blocker（不覆盖在住）+
    Checkout 停用；future reservation 保留；multiple blockers / Last Blocking；
    Rework / Cancel / Manual OOS 保护；Check-in 409；RBAC 矩阵 + FINANCE；
    PII（工单无 Guest 数据 + MAINTENANCE 无 Booking PII 出口）；完成 ≠ 清洁；
    S5 缺陷修复（occupied + 未来预订 + blocking MWO → 前台主动维修风险 Attention）
  - S6 新增 `room-move.spec.ts` 4 条（辅助集中在 `e2e/room-move-helpers.ts`，
    复用种子房 301-308 归一化策略，不新建房间）：Golden Path UI 全链路
    （Check-in A → Front Desk [换房] A→B → B 在住 / A dirty + ROOM_MOVE 保洁任务 /
    Diary 在住条画在 B / Stay 详情房间记录 + 原分配房 vs 当前在住房）；
    blocking Maintenance on occupied A → 换房 → A OOS+MAINTENANCE+dirty、维修仍 active；
    HTTP 并发 Move A→T vs Move B→T（1×200 + 1×409）；
    HTTP 并发 Move→T vs Create Reservation→T（no double allocation）
   - S7 新增 `inventory-procurement.spec.ts` 4 条（辅助集中在
     `e2e/inventory-helpers.ts`，物资代码 E2E-ITEM-* 前缀，测试库每次运行重建）：
     Golden A（UI 新建物资 → 期初库存 → 领用 → 余额减少 → INITIAL/ISSUE 流水可见 +
     API 口径 ledger == balance）；Golden B（调拨 → 来源减少 / 目的地增加 /
     酒店总库存不变 + TRANSFER_OUT/IN 成对流水）；Golden C（采购申请 → 提交 → 批准 →
     转采购订单 → 下达（PO 不改变库存断言）→ 部分收货（余额只增加实收数量）→
     最终收货 → PO RECEIVED + 两条 PURCHASE_RECEIPT 流水）；Golden D（低库存物资 →
     /inventory 低库存徽标 + 建议补货 → Dashboard 库存与采购预警可见）
  - 各 spec 使用专属房间号段保证用例间确定性；既有 auth/rbac/rooms/settings 4 个 spec 与
    `playwright.config.ts` 隔离机制保持不变
  - S8 新增 `z-analytics.spec.ts` 6 条（辅助集中在 `e2e/analytics-helpers.ts`，
    房间 206 归一化后使用；历史房晚/保洁/工单/库存/收货时间经真实 UPDATE 脚本回填
    `setup_backdate_stay.py` / `setup_backdate_procurement.py`，不 mock）：
    Flow A（ADMIN：Physical Occupancy 0.1%、实际房晚、保洁完成、维修新建与
    高频报修房间、On-books 可见）、Flow B（MANAGER：合同房费 ¥300.00、合同 ADR/
    RevPAR、库存与采购、到货金额 ¥60.00、供应商）、Flow C（FRONT_DESK：
    operations 可见 + business 缺席 + 零 business 请求；FINANCE：business 可见 +
    operations 缺席 + 零 operations/forecast 请求）、Flow D（空数据区间正常渲染，
    无 NaN / Infinity）、Flow E（QA D1 Calendar Comparison：API 断言 This Month /
    Last Month 的 comparison.period 精确区间 + UI 抽查对比 chip 与上月范围标签）。
    文件名带 `z-` 前缀使本 spec 最后执行（库存/采购为不可变账本无 DELETE，
    避免污染其它 spec 的全量列表断言）。Backdate 脚本 Safety（QA D2）：
    `setup_backdate_procurement.py` / `setup_backdate_stay.py` 硬性限定数据库名
    == stayops_test（DATABASE_URL 缺失即拒绝、开发库写前拒绝）、只修改显式传入
    的行 ID、单事务 validate→update→commit（安全测试见
    `backend/tests/test_analytics_backdate_safety.py`）
- **后端 pytest**（`backend/`，440 用例 = 379 基线 + Sprint 8 Analytics 37 +
  QA 修复 24：黄金数据集 9（人工已知结果 exact assert）、Room Move 防重复计数
  3（203→205、203→205→208）、Forecast 去重 4、日期边界 5（含月/年边界与午夜
  时区转换）、零数据 2、周期对比 2、六角色 RBAC 4、PII 扫描 1、参数校验 5
  （from<to、to<=业务日期、跨度<=366）、权限 seed 1（50 权限码 + code + role
  matrix）、comparison modes 17（等长/上一自然月/本月 elapsed 与月末 clamp/
  闰年/30·31 天月/跨年/非法值/API 接线）、backdate safety 7（stayops 拒绝零
  连接、未知库拒绝、缺失 URL 拒绝、无目标 ID 拒绝、非法 ID 回滚零修改、
  显式 ID 只更新指定行 + unrelated 行不变、URL 解析）；
  既有 8 个权限码计数用例语义更新为 50）：独立测试库 `stayops_test`（与 E2E 同库策略），
  会话级 DROP/CREATE + 迁移 + seed，用例级事务回滚隔离；并发用例（Double Booking / Check-in / Check-out / 业务单号 / Duplicate Active Task / Concurrent Start / PASS vs REWORK / D1 25 轮双订 / S5 同房双阻断创建 / 并发 verify / cancel vs verify / S6 move-vs-move / move-vs-reservation / move-vs-checkout / reservation-update-vs-move / S7 issue-vs-issue / transfer-vs-issue / stocktake-vs-issue / receipt-vs-receipt / receipt-vs-issue / receipt-vs-transfer / request-to-po-vs-request-to-po 各 10 轮 stress）用两线程 + 独立 Session 真实提交验证。
  pytest 与 Playwright E2E 共享 `stayops_test` 且互斥（不得并行运行）。

## 原则

- 前后端分离，通过 REST API 通信
- 业务权限在后端验证（前端隐藏按钮不算权限控制）
- 数据库 Schema 变更一律使用 Migration
- 重大架构决策记录到 `DECISIONS.md`
