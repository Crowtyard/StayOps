# StayOps — 精品住宿智能运营系统

**项目类型：** 精品住宿运营管理系统

**实际使用场景：** 济南市历下区 CBD，中高端住宿项目，约 28 间客房。

## V1 目标

建立内部运营系统，统一管理：

- 房间
- 房态
- 预订
- 入住记录
- 住中换房（Room Move）
- 保洁
- 查房
- 维修
- 库存
- 采购
- 经营数据

## 核心领域模型（Sprint 6 起，Domain Decision LOCKED）

```text
Reservation         = 商业预订 / 未来房间分配（Check-in 后 room_id 冻结为原分配房）
Stay                = 实际住宿（room_id = 当前实际房间快速指针）
StayRoomAssignment  = 实际住宿期间的房间历史（ended_at = NULL 表示当前 active assignment）
```

- Check-in 原子建立 assignment #1（room = check-in room）；
  Room Move 关闭旧 assignment 并开启新 assignment；
  Check-out 关闭当前 assignment。
- Room Move 不得创建第二个 Stay；`Reservation.room_id` 换房后保持原分配房；
  ACTIVE Stay 的当前房间一律来自 `Stay.room_id` / current Assignment；
  Reservation 排他约束仅作用于 CONFIRMED（未来分配），实际占用由 Stay 表达。

## 库存与采购领域模型（Sprint 7 起，Domain Decision LOCKED）

```text
InventoryItem      = 库存物资档案（item_code 唯一不可变，base_unit 唯一基础单位）
InventoryLocation  = 库存地点（多地点：总仓 / 前台 / 保洁间 / 维修间）
StockMovement      = 永久库存账本事实（immutable ledger；无 PATCH/DELETE）
InventoryBalance   = 快速查询 Projection（投影），唯一 (item_id, location_id)
StockIssue         = 领用单（多行整体原子）
Supplier           = 供应商（停用不删除）
PurchaseRequest    = 采购申请（DRAFT → SUBMITTED → APPROVED → ORDERED）
PurchaseOrder      = 采购订单（DRAFT → ORDERED → PARTIALLY_RECEIVED → RECEIVED）
GoodsReceipt       = 收货单（收货才是库存增加权威）
```

- **no movement = no stock change**：库存变化只能来自业务动作
  （INITIAL / PURCHASE_RECEIPT / ISSUE / RETURN / TRANSFER_OUT /
  TRANSFER_IN / ADJUSTMENT_IN / ADJUSTMENT_OUT），流水与余额同事务更新。
- **PO 不改变库存**；只有 Goods Receipt 创建 PURCHASE_RECEIPT 流水并增加库存；
  部分收货 cumulative received <= ordered。
- 无自动客耗扣账（Checkout / Housekeeping / Room Move 不扣库存）。
- 低库存：total==0 → OUT_OF_STOCK，total<=minimum → LOW_STOCK；
  建议补货 = max(target-total, 0)，仅建议不自动下单。

## 经营分析（Sprint 8 起，Analytics = read-only derived layer）

```text
Metric Dictionary（docs/ANALYTICS.md）
      ↓
Analytics Service（SQL aggregation / CTE，无第二套业务事实表）
      ↓
Analytics API（operations / business 权限域分离）
      ↓
Management Cockpit（/analytics 四 Tab：总览 / 客房与预订 / 运营效率 / 库存与采购）
      ↓
S9 AI General Manager（AI 店长：消费同一 Analytics API + 只读 SQL）
```

- 正式业务表仍是 Source of Truth；不建立 daily_statistics / analytics_fact /
  analytics_warehouse；无 ETL、无自动物化。
- Backend 是指标计算唯一权威；Frontend 只 request → format / visualize。
- Actual（已实际发生）与 On-Books / Forecast（已掌握的未来计划）严格分离；
  全部区间 [from, to) + Business Date（Asia/Shanghai）；Actual 至多统计到
  业务日期当天之前。
- 酒店总体实际房晚 MUST derive from Stay（Room Move 防重复计数）；
  Physical Occupancy ✅ / Sellable Occupancy ❌；合同房费金额 / 合同 ADR /
  合同 RevPAR（非实际收款语义）。
- 零数据原生支持（Count→0、Rate/Average 分母 0→null、Empty→[]），禁止
  NaN / Infinity / fake business data。
- RBAC：analytics:operations_read（SUPER_ADMIN/MANAGER/FRONT_DESK）与
  analytics:business_read（SUPER_ADMIN/MANAGER/FINANCE），无权限域不请求。

## AI 店长（Sprint 9 起，DeepSeek AI Manager）

- 入口：/ai-manager（Chat）+ /settings/ai（DeepSeek 配置），
  ai_manager:use / ai_manager:manage 权限（见 docs/AI_MANAGER.md）。
- 架构：/ai-manager → Backend → DeepSeek API → S8 Analytics + 只读 SQL
  （PostgreSQL）。不是复杂 Agent 平台，Alpha.9 只要一个真正可用、简单、
  安全的 AI 数据分析入口。
- 三条安全规则 LOCKED：AI 数据库访问 = 只读；API Key 只在 Backend；
  AI 没有任何写工具（无自动改房态/建维修/采购/调库存/定价等能力）。
- AI 可见数据 = 当前用户既有权限（operations/business 域继承），
  Guest PII 与敏感字段在数据库视图层物理排除。
- 详细文档：docs/AI_MANAGER.md

## V1 核心模块

1. 登录与 RBAC 权限
2. 首页经营驾驶舱
3. 房态管理
4. 预订 / 入住 / 退房（Booking & Stay Core Flow）
5. 住中换房（Room Move & In-Stay Recovery）
6. 保洁管理
7. 维修工单
8. 库存采购
9. 经营分析
10. AI 店长（DeepSeek AI Manager，Sprint 9）

## V1 暂不自行实现（未来通过 PMS 或第三方 API 集成）

- 公安实名登记底层系统
- OTA 库存实时同步
- 微信支付底层
- 支付宝支付底层
- 智能门锁底层
- 发票底层系统
