# StayOps 经营分析（Analytics）— Metric Dictionary

> Sprint 8 · Business Analytics · 本文档是产品架构的一部分（§39）。
> 代码镜像：`backend/app/core/analytics_metrics.py`（集中 Metric Definitions / constants）。

## 0. 架构原则（Sprint 8 §2 LOCKED）

```text
Metric Dictionary
      ↓
Analytics Service（SQL aggregation / CTE，read-only derived layer）
      ↓
Analytics API（operations / business 权限域分离）
      ↓
Management Cockpit（/analytics 四 Tab，Frontend 只 request → format / visualize）
      ↓
Future S9 AI General Manager（消费同一 Analytics API）
```

- **Analytics = read-only derived layer**：正式业务表（reservations / stays /
  housekeeping_tasks / maintenance_work_orders / stock_movements /
  goods_receipts …）仍然是 Source of Truth；**不建立** daily_statistics /
  monthly_statistics / analytics_fact / analytics_warehouse 等第二套业务事实；
  **无 ETL、无自动物化**。当前规模使用 PostgreSQL 聚合查询即可（§2.1）。
- **Backend 是指标计算唯一权威**：Frontend 禁止自行 fetch 业务表组合计算
  Occupancy；只能 request Analytics API → format / visualize（§2.2）。
- **Actual ≠ Forecast**：Actual 只统计已实际发生；On-Books / Forecast 只统计
  当前已掌握的未来计划（§2.3）。
- **统一时间语义**：全部区间为半开区间 `[from, to)`，日期口径一律
  Business Date（Asia/Shanghai，§2.4）。Actual 至多统计到
  `current_business_date`（exclusive，§3）。
- **零数据语义（RELEASE BLOCKING，§33）**：Count -> 0；Rate/Average 分母 0
  -> `null`；Empty series -> `[]`。**禁止 NaN / Infinity / fake business data**。
- **Money 一律 Decimal/Numeric**（JSON 字符串序列化，§18）；Rate 使用
  ratio 0..1（如 `0.643`），UI 显示 `64.3%`（§7）。
- **PII（§36）**：Analytics 不返回 Guest name / phone / contact / notes；
  Supplier phone / notes 不进入 Analytics。

## 1. 权限域（§34/§35）

| 权限 code | 域 | 覆盖指标 |
|---|---|---|
| `analytics:operations_read` | operations | Occupancy / Bookings / Stay / Housekeeping / Maintenance / Room Move / Forecast |
| `analytics:business_read` | business | Contracted Room Value / Contracted ADR / Contracted RevPAR / Inventory Analytics / Procurement Analytics / Supplier value |

角色矩阵（用 permission 判断，禁止硬编码角色名）：SUPER_ADMIN 与 MANAGER
两域全开；FRONT_DESK 仅 operations；HOUSEKEEPING / MAINTENANCE 无；
FINANCE 仅 business。`/analytics` 页面持有任一 analytics 权限即可进入；
Frontend 对无权 Domain **DO NOT FETCH**（不允许 fetch → 403 → 静默隐藏）。

## 2. 指标（Metric Dictionary）

> 字段说明：公式中的 `[from, to)` 为报告区间；`bd(ts)` = Asia/Shanghai
> Business Date；`D0` = current_business_date。

### 2.1 占用 Occupancy（operations）

| Metric Code | 中文名 | English | 公式 / 定义 | 零分母 |
|---|---|---|---|---|
| `actual_occupied_room_nights` | 实际占用房晚 | Actual Occupied Room Nights | 酒店总体房晚 MUST derive from **Stay**（§5）：`Σ |[from,to) ∩ [bd(actual_check_in_at), check_out_bd)|`；COMPLETED 的 check_out_bd = `bd(actual_check_out_at)`，**ACTIVE 的 check_out_bd = D0**（实际历史不能被 planned_checkout 截断，§4/§6）。**禁止 SUM(StayRoomAssignment durations)**（Room Move 防重复计数） | 0 |
| `physical_room_nights` | 物理房晚 | Physical Room Nights | `physical_room_count × report_days`；`physical_room_count` 必须查询当前正式 Room master（禁止硬编码 28，§6）。Alpha.8 假设报告期内物理房间库存稳定 | 0 |
| `physical_occupancy_rate` | 物理入住率 | Physical Occupancy Rate | `actual_occupied_room_nights / physical_room_nights`。**只提供 Physical Occupancy；不提供 Sellable Occupancy**（当前无可靠历史 room_sellability_intervals，§8） | `null` |

### 2.2 Stay / 入住（operations）

| Metric Code | 中文名 | 公式 / 定义 | 零分母 |
|---|---|---|---|
| `active_stays` | 当前在住 | Snapshot：`COUNT(status='ACTIVE')` | 0 |
| `overdue_active_stays` | 超期在住 | Snapshot：`COUNT(ACTIVE 且 planned_check_out_date <= D0)`；不得因此擅自发明未来住宿 nights（§10） | 0 |
| `completed_stays` | 完成住宿数 | `COUNT(status='CHECKED_OUT' 且 bd(actual_check_out_at) ∈ [from,to))` | 0 |
| `average_length_of_stay` | 平均住宿时长 | 完成 cohort 的 `Σ(bd(co) - bd(ci)) / completed_stays`（实际 check-in → checkout，不用计划 nights，§16） | `null` |

### 2.3 Arrival Cohort 预订到达组（operations，§12）

Arrival Cohort = `Reservation.check_in_date ∈ [from, to)`。

| Metric Code | 中文名 | 公式 / 定义 | 零分母 |
|---|---|---|---|
| `scheduled_arrivals` | 计划到店预订数 | Arrival Cohort 全部预订（含后续 CANCELLED / NO_SHOW） | 0 |
| `cancelled_arrivals` | 已取消到店预订数 | Cohort 内 `status='CANCELLED'` | 0 |
| `cancellation_rate` | 取消率 | `cancelled_arrivals / scheduled_arrivals`（§13） | `null` |
| `no_show_count` | 未到店数 | Cohort 内 `status='NO_SHOW'` | 0 |
| `no_show_rate` | 未到店率 | `no_show_count / (scheduled - cancelled)`（§14） | `null` |
| `average_booking_lead_days` | 平均预订提前天数 | 非 CANCELLED 的 cohort：`AVG(max(0, check_in_date - bd(created_at)))`（§15；提前天数不可能为负） | `null` |
| `booking_lead_distribution` | 预订提前天数分布 | 非 CANCELLED 分桶：`0-1 / 2-3 / 4-7 / 8-14 / 15-30 / 31+`（Bucket 逻辑 Backend 权威，§15） | `[]` |

### 2.4 Room Move 换房（operations，§25）

Move event = `StayRoomAssignment.reason IS NOT NULL`；Move timestamp =
新 assignment 的 `started_at`（canonical）。

| Metric Code | 中文名 | 公式 / 定义 | 零分母 |
|---|---|---|---|
| `room_move_count` | 换房次数 | 区间内 move events 数 | 0 |
| `moved_stay_count` | 发生换房的住宿数 | 区间内 `COUNT(DISTINCT stay_id)`（一个 Stay 换房三次：count=3、moved=1） | 0 |
| `room_move_rate` | 换房率 | 入住 cohort（`bd(actual_check_in_at) ∈ [from,to)`）中有 ≥1 次换房的 Stay 占比 | `null` |
| `room_moves_by_reason` | 换房原因分布 | GROUP BY reason | `[]` |
| `room_moves_by_source_room` | 换出房分布 | 来源房 = **上一个** assignment 的 room（self-join `prev.ended_at = cur.started_at`） | `[]` |

### 2.5 Channel Performance 客源渠道（business，alpha.9.6 F4）

**「客人从哪里来」** —— 归因链：`Stay → Reservation.source_channel_id → Channel`。
端点 `GET /analytics/business/channels`，权限 `analytics:business_read`。

| Metric Code | 中文名 | 公式 / 定义 | 零分母 |
|---|---|---|---|
| `order_count` | 渠道订单数 | Arrival Cohort：`reservation.check_in_date ∈ [from,to)`，**排除 `CANCELLED` / `NO_SHOW`**（与 §2.3 同源同界） | 0 |
| `stay_count` | 渠道住宿数 | `COUNT(DISTINCT stay_id)`（Room Move 不重复计数） | 0 |
| `occupied_room_nights` | 渠道实际房晚 | 逐字复用 §2.1 的 `stay_intervals`（COMPLETED 用 `bd(actual_check_out_at)`，ACTIVE 用 `current_business_date` exclusive），仅统计归属于该渠道的住宿 | 0 |
| `contracted_room_value` | 渠道合同房费 | 逐字复用 §2.5 口径：`agreed_total_amount / planned_nights` 分摊到落在 planned interval 内的实际房晚 | `0.00` |
| `contracted_adr` | 渠道合同 ADR | `contracted_room_value / occupied_room_nights`；**合同口径、非实际收款** | `null` |
| `share` | 渠道占比 | `渠道合同房费 / 区间合同房费总额`（ratio 0..1） | `null` |

口径纪律（LOCKED）：

- **收入口径不新造**：与 `/business/rooms` 使用同一事实源与同一分摊公式；
  同区间 `totals.contracted_room_value` 必须与 `/business/rooms` 的
  `contracted_room_value` **精确相等**（pytest 对账测试锁定）。
- **每单恰好一次**：归因走 `Stay → Reservation.source_channel_id`，
  不使用 `stay_room_assignments`（换房会造成重复计数）。
- **取消与未到店不计入**订单数 / 房晚 / 房费。
- **对账不变式**：`Σ channels + unassigned == totals`（`unassigned` = 未指定渠道桶）。
- **命名**：StayOps 无 Folio / Payment / Settlement → **禁止「营业收入 / 实收」**；
  UI 必须注明「合同房费（非实际收款）」。
- 渠道**停用后历史业绩仍展示**，并标记 `channel_enabled=false`。
- 响应不含任何 Guest PII（payload 扫描测试锁定）。

### 2.6 Contracted Room Value 合同房费（business，§17-§22）

命名 LOCKED：StayOps 无 Folio/Payment/Settlement，**禁止使用 Revenue /
营业收入 / 实收**；正式名称 = Contracted Room Value / 合同房费金额。

| Metric Code | 中文名 | 公式 / 定义 | 零分母 |
|---|---|---|---|
| `contracted_room_value` | 合同房费金额 | 只有已实际入住形成 Stay 的住宿可贡献（§19）。每个 Actual occupied night 若同时落在 Reservation planned interval `[check_in_date, check_out_date)` 且 `agreed_total_amount` 可用 → 贡献 `agreed_total_amount / planned_nights`（§18 合同每晚价值）。超出原计划区间的实际住宿：occupied night 计入、contract value **不计**（不得猜价格） | `0.00` |
| `priced_occupied_room_nights` | 有价实际房晚 | 落在 planned interval 内的实际房晚数（§20） | 0 |
| `unpriced_occupied_room_nights` | 无价实际房晚 | `actual_occupied_room_nights - priced_occupied_room_nights`（Data Quality；正常期望 0，>0 必须显式暴露；禁止用前一晚/平均价格补值） | 0 |
| `contracted_adr` | 合同 ADR | `contracted_room_value / priced_occupied_room_nights`；UI 注明**非实际收款**（§21） | `null` |
| `contracted_revpar` | 合同 RevPAR | `contracted_room_value / physical_room_nights`；UI 注明**合同 RevPAR、物理房间分母**，非财务正式 RevPAR（§22） | `null` |

### 2.7 Housekeeping 保洁（operations，§23）

| Metric Code | 中文名 | 公式 / 定义 | 零分母 |
|---|---|---|---|
| `housekeeping_completed_tasks` | 完成保洁任务数 | `bd(completed_at) ∈ [from,to)` | 0 |
| `housekeeping_backlog` | 保洁积压 | **Snapshot**：`status ∈ PENDING/IN_PROGRESS/INSPECTION/REWORK`（§9：不得把当前 backlog 当作周期指标） | 0 |
| `average_housekeeping_cycle_minutes` | 平均保洁周期（分钟） | 区间内完成任务：`AVG(completed_at - created_at)` | `null` |
| `checkout_turnover_minutes` | 退房翻房时长（分钟） | `source=CHECKOUT` 且区间内完成：`AVG(completed_at - created_at)` | `null` |
| `room_move_cleaning_tasks` | 换房保洁任务数 | `source=ROOM_MOVE` 且 `bd(created_at) ∈ [from,to)` | 0 |

### 2.8 Maintenance 维修（operations，§24）

| Metric Code | 中文名 | 公式 / 定义 | 零分母 |
|---|---|---|---|
| `maintenance_created` | 新建维修工单数 | `bd(created_at) ∈ [from,to)` | 0 |
| `maintenance_completed` | 完成维修工单数 | `bd(completed_at) ∈ [from,to)` | 0 |
| `active_maintenance` | 进行中维修工单 | Snapshot：`status ∈ OPEN/ASSIGNED/IN_PROGRESS/RESOLVED` | 0 |
| `active_blocking_maintenance` | 阻断性维修工单 | Snapshot：active 且 `blocks_room=true` | 0 |
| `mean_time_to_resolution_minutes` | 平均维修解决时长 | `bd(resolved_at) ∈ [from,to)`：`AVG(resolved_at - created_at)` | `null` |
| `mean_verification_minutes` | 平均验收时长 | `bd(completed_at) ∈ [from,to)`：`AVG(completed_at - resolved_at)` | `null` |
| `maintenance_by_category` | 按分类分布 | 区间内新建 GROUP BY category | `[]` |
| `maintenance_by_room` | 按房间分布（高频报修房间） | 区间内新建 GROUP BY room | `[]` |

Alpha.8 **不实现** historical maintenance downtime room nights（无确定性事实）。

### 2.9 Inventory 库存（business，§26-§28）

| Metric Code | 中文名 | 公式 / 定义 | 零分母 |
|---|---|---|---|
| `current_low_stock_items` | 低库存物资数 | Snapshot：`total > 0 且 minimum > 0 且 total <= minimum`（启用物资） | 0 |
| `current_out_of_stock_items` | 缺货物资数 | Snapshot：`total == 0`（启用物资） | 0 |
| `item_issue_quantity` | 领用量 | 每 Item：`SUM(abs(quantity))` where `movement_type='ISSUE'` 且 `bd(created_at) ∈ [from,to)`。**gross issue activity，不减 RETURN**；**禁止跨不同 Base Unit 求和**（每 Item / 每 Base Unit 单独给出，§26） | 0 |
| `issue_quantity_per_occupied_room_night` | 每实际房晚领用强度 | `item_issue_quantity / actual_occupied_room_nights`（每 Item；这是酒店库存领用强度，**不等于客人实际消费量**——无自动客耗扣账，Sprint 7） | `null` |

### 2.10 Procurement 采购（business，§29/§30）

| Metric Code | 中文名 | 公式 / 定义 | 零分母 |
|---|---|---|---|
| `purchase_requests_created` | 新建采购申请数 | `bd(created_at) ∈ [from,to)` | 0 |
| `pending_purchase_requests` | 待处理采购申请 | Snapshot：`status ∈ SUBMITTED, APPROVED`（待审批 + 待转单） | 0 |
| `purchase_orders_created` | 新建采购订单数 | `bd(created_at) ∈ [from,to)` | 0 |
| `pending_receipt_orders` | 待收货订单 | Snapshot：`status ∈ ORDERED, PARTIALLY_RECEIVED` | 0 |
| `partially_received_orders` | 部分收货订单 | Snapshot：`status = PARTIALLY_RECEIVED` | 0 |
| `received_purchase_value` | 到货采购金额 | `Σ(GoodsReceiptLine.received_quantity × PurchaseOrderLine.unit_price)`，日期归属 = **`bd(GoodsReceipt.received_at)`**（禁止用 PO created_at）。`unit_price IS NULL` 不猜价格 → 计入 `unpriced_received_lines`。UI 注明：**≠ 已付款金额、≠ 会计成本** | `0.00` |
| `unpriced_received_lines` | 无单价收货行 | Data Quality 指标 | 0 |
| `received_value_by_supplier` | 按供应商到货金额 | GROUP BY supplier（只含 supplier_code / name，**不含 phone / notes**） | `[]` |
| `received_value_by_item` | 按物资到货金额 | GROUP BY item | `[]` |

### 2.11 On-Books Forecast 在册预测（operations，§10/§11）

| Metric Code | 中文名 | 公式 / 定义 | 零分母 |
|---|---|---|---|
| `on_books_7d / 14d / 30d` | 在册占用率（7/14/30 日） | 未来 horizon 天在册房晚 ÷ `physical_room_count × horizon`。Horizon 起点 = `D0`。来源：**CONFIRMED Reservation**（`[check_in, check_out) ∩ [D0, D0+horizon)`）+ **ACTIVE Stay remaining planned occupancy**（`[D0, planned_check_out)`；`planned_check_out <= D0` 不贡献——超期运营问题由 `overdue_active_stays` 反映）。**禁止** CANCELLED / NO_SHOW / 历史 COMPLETED / `CHECKED_IN Reservation.room_id`。最终按 **distinct (business_date, room_id)** 仲裁去重（防 ACTIVE Stay + linked Reservation 双算） | `null` |
| Forecast daily | 未来 30 日每日在册 | 每日 distinct 房晚数（无预订日 = 0，序列由日程定义） | — |

## 3. Analytics API（§37/§38）

统一前缀 `/api/v1/analytics`；Actual 端点参数 `from=YYYY-MM-DD & to=YYYY-MM-DD`
（必填）、`compare=true|false`（默认 false）、`comparison_mode=`（对比语义，
见 §3.1）。校验：`from < to`（422）、`to <= current_business_date`（422，不允许
未来实际数据）、跨度 ≤ 366 天（422）、`comparison_mode` 非法（422）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /analytics/operations/overview | operations | 周期指标 + 当前快照 + On-books 7/14/30 + 可选对比 |
| GET | /analytics/operations/bookings | operations | Arrival Cohort + 提前天数分布 + ALOS + 换房 + 每日占用趋势 |
| GET | /analytics/operations/housekeeping | operations | 保洁周期/翻房/换房保洁 + 积压快照 + 每日完成 |
| GET | /analytics/operations/maintenance | operations | 新建/完成/MTTR/验收 + 分类/房间分布 + 阻断快照 |
| GET | /analytics/operations/room-moves | operations | 次数/涉及住宿/换房率 + 原因/换出房分布 |
| GET | /analytics/business/rooms | business | 合同房费/有价与无价房晚/合同 ADR/合同 RevPAR + 每日趋势 |
| GET | /analytics/business/channels | business | **客源渠道经营分析**（alpha.9.6 F4）：渠道订单数/实际房晚/合同房费/占比/合同 ADR + 合计与「未指定渠道」桶 |
| GET | /analytics/business/inventory | business | 低/缺货快照 + 每物资领用量与领用强度 |
| GET | /analytics/business/procurement | business | 申请/订单/待收货 + 到货采购金额（供应商/物资/每日） |
| GET | /analytics/forecast | operations | 7d/14d/30d + 30 日每日序列 |

禁止单个 `/analytics/everything` 聚合端点返回全部敏感指标（operations 与
business 权限必须分离）。

### 3.1 周期对比（§31/§32 + QA D1 Comparison Modes）

`compare=true` 时通过 `comparison_mode` 指定对比语义（受限枚举，非法值 422；
`compare=false` 时该参数不改变结果）：

- `equal_length`（默认，过去 7/30/90 天与自定义）：previous =
  `[from - days, from)`；
- `previous_calendar_month`（上月）：previous = `[上月初, 本月初)`（上一完整
  自然月，两月天数无需相同）；
- `previous_month_elapsed`（本月）：previous = `[上月初, 上月初 + elapsed)`，
  elapsed = `to - from`（MTD 已过日数），**clamp 于上一自然月月末**——例如
  3 月 MTD 30 日 vs 2 月 28 天 → `[2/1, 3/1)`；闰年 2 月（29 天）、30/31 天月、
  1 月 vs 12 月（跨年）同理由月末钳制，禁止跨出上一自然月凑等长。

变化语义不变：比率指标 → `pp_delta`（percentage points，`0.60 → 0.65` 显示
`+5.0 pp`）；数量 / 金额 / 平均 → `percent_change`；`previous = 0` → `null`
（**禁止 Infinity%**）。`comparison_mode` 由前端按 preset 发送，上一周期区间
与指标计算全部由 Backend 权威完成（前端禁止自行计算）。

## 4. Management Cockpit（/analytics，§43-§48）

- 顶部统一 Date Selector：过去7天 / 过去30天 / 过去90天 / 本月 / 上月 / 自定义
  （默认过去 30 天；Actual to 最大 = 业务日期）+ 「与上一周期对比」开关。
- 四个 Tab（不建立十几个 analytics route）：总览 Overview / 客房与预订
  Rooms & Bookings / 运营效率 Operations / 库存与采购 Inventory & Procurement。
- 总览（§45）：Operations 权限可见 Physical Occupancy / Actual Room Nights /
  ALOS / Cancellation / No-show / Lead Time / Room Move Rate / HK Backlog /
  Blocking Maintenance / On-books 7/14/30；Business 权限可见 Contracted Room
  Value / Contracted ADR / Contracted RevPAR / Low Stock / Out of Stock /
  Pending Purchase Requests / Pending Receipt Orders。只有一种权限时另一域
  **no fetch、no hidden 403**。
- 可视化原则（§49/§51）：KPI Cards / Line Chart / Bar Chart / Ranking Table /
  Status Table；无 3D、无大饼墙、无地图、无粒子动画、无 fake realtime；
  图表有标签、点值 title 访问、移动端自适应；重要数值不只靠颜色表达。
- 库存与采购（§48）：不跨 Base Unit 汇总物资数量。

## 5. 测试（Golden Dataset，§52/§53）

`backend/tests/analytics_helpers.py::build_golden` 构造确定性 Golden Analytics
Dataset（真实 API 链路 + ORM 时间戳回填），`test_analytics_golden.py` 对
人工已知结果 exact assert：occupied room nights / physical occupancy /
cancellation / no-show / lead time 与分桶 / ALOS / room moves / contracted
value / priced & unpriced nights / ADR / RevPAR / housekeeping cycle /
checkout turnover / maintenance MTTR & verification / issue quantity &
intensity / received purchase value（Money 用 Decimal 精确比较）。

P0 专项：Room Move 防重复计数（§54）、Forecast 去重（§55）、日期边界与
ACTIVE/超期语义（§56）、零数据（§57）、周期对比（§58）、RBAC 六角色（§59）、
PII 扫描（§60）、参数校验（§3/§38）。
