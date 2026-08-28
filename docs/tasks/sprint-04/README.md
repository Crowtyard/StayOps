# Sprint 4 · Front Desk Command Center & Room Diary（前台运营指挥台与房态日历）

> 开发模式：FAST TRACK · REUSE FIRST · ONE SPRINT / ONE DSH SESSION（不拆 T1/T2/T3）
> 计划版本：v1.0.0-alpha.4（Sprint 完成不自行创建 Release；等待 Kun Fast QA）
> 基线：pytest 202 / Vitest 170 / Playwright 36（Sprint 1–3 已冻结）

## 1. 目标

建立 `/front-desk` 前台运营工作台：前台员工打开一个页面，10 秒内知道：

- 今天发生什么（到店 / 离店 / 在住 / 空净房 / 需关注）
- 28 间房当前是什么状态（占用 + 清洁双状态）
- 未来哪些房有预订（1/7/14/30 天时间线）
- 哪些房还没准备好（今日到店但未清洁 → 明确解释 + 保洁任务）
- 当前最需要处理什么（Attention Center 三条固定规则）

Sprint 4 不是新增 CRUD 后台，而是组合 Room / Guest / Reservation / Stay / Housekeeping 既有能力。

## 2. 信息架构（固定，不可改变）

```text
Front Desk Command Center（/front-desk）

├── Today Summary        今日到店 / 今日离店 / 当前在住 / 空净房 / 需关注（可点击 → 右侧 Drawer）
├── Search / Filters     房号 / Guest name / phone / reservation_no 统一搜索；楼层 / 房型筛选
├── Room Diary           28 房 × 1/7/14/30 天时间线（页面主体，不放大统计卡）
└── Right-side Drawer    Arrivals / Departures / Attention / Reservation Quick View / Room Quick View
```

## 3. 范围（Scope）

### In Scope

- Today Summary（5 卡可点击，抽屉展示列表，不跳离 /front-desk）
- Room Diary：28 房全量（无分页）、楼层分组、楼层/房型筛选、1/7/14/30 天窗口、
  左侧房间栏固定（sticky）、日期区横向滚动
- 房间双状态保留：occupancy_status + cleaning_status 同时展示，不合并
- Reservation Timeline：严格 `[check_in_date, check_out_date)`（入住日晚至退房日前一晚，
  退房日可接下一笔；首尾相邻必须准确，无 off-by-one）
- 时间线默认只展示 CONFIRMED / CHECKED_IN；CANCELLED / NO_SHOW 不作为占用条；
  COMPLETED 不作未来主条
- Reservation Bar：Guest name（guest:read）/ status / source；tooltip 受 RBAC/PII 控制
- Reservation Drawer：Room / Guest / Dates / Nights / Source / Amount / 状态 /
  房间占用 / 房间清洁 / 保洁任务 + Check-in / Edit / Cancel / No-show / Full Detail
- §11 未准备房间：今日到店且 cleaning != clean → 不把 Check-in 作为主操作，
  显示「房间尚未准备完成」+ Active HousekeepingTask（Task No / status / assignee）+
  查看保洁任务；后端 Check-in 409 仍是最终权威
- 点击空白日期格：新建预订（预填 room_id / check_in / check_out=check_in+1，复用
  /reservations/new 现有表单）/ 查看房间；Backend Availability 仍重新验证
- Search：房号（本地匹配）/ Guest name / phone / reservation_no（复用现有 search API）；
  结果点击定位房间 / 定位日期 / 打开 Drawer；PII 搜索受 guest:read 约束
- Attention Center（三条固定规则，不做 Rule Engine）：
  - A：今日到店 AND Room.cleaning_status != clean
  - B：Stay = ACTIVE AND planned_checkout_date < business_date
  - C：未来 CONFIRMED AND Room occupancy_status IN (blocked, out_of_service)
  - 每项直接告诉员工：哪个房间 / 什么问题 / 哪笔业务 / 下一步去哪处理
- Room Quick View：room_no / room_type / 双状态 / current active stay /
  active housekeeping task / next reservation / 完整房间详情
- Housekeeping 集成：只消费 Alpha.3 能力（无 housekeeping_task:read 不请求不显示）
- Mobile（<768px）：FrontDeskTodayBoard（Today Summary / Search / Attention /
  Arrivals / Departures / Stays），不渲染完整 Room Diary
- Responsive：>=1024px Full Diary；768–1023px Compact；<768px Today Board（Playwright 实测）
- 写操作后 targeted refetch；60s 轻量轮询（Drawer 打开时暂停，不覆盖输入、不关闭 Drawer）

### Out of Scope（明确禁止）

Drag-and-drop 排房 / 换房 / 多房预订 / 团队预订 / OTA / Channel Manager /
价格与收益管理 / Night Audit / 支付押金发票 Folio / 维修库存 / CRM 会员 /
WebSocket 实时 / AI。

## 4. 权限（不新增 front_desk:* 权限）

- 页面最低：`room:read` + `reservation:read`（导航入口按权限 code 显隐，不用角色名）
- SUPER_ADMIN / MANAGER / FRONT_DESK → visible；HOUSEKEEPING / MAINTENANCE / FINANCE → hidden
- 操作分别依赖：guest:read / reservation:write / reservation:cancel /
  reservation:no_show / stay:check_in / stay:check_out / housekeeping_task:read
- PII 双边界：后端按 guest:read 裁剪响应（键缺失），前端再按权限隐藏；
  无 guest:read 时 UI 不发起姓名/手机号搜索（仅房号 / 预订单号）

## 5. Backend 原则（Read-heavy）

- 不创建 `/front-desk/everything` 聚合 API
- 允许的最小扩展：Reservation List 增加 `overlap_from` / `overlap_to`
  （语义 `check_in < overlap_to AND check_out > overlap_from`，[from, to)，
  必须成对、to > from 否则 422；permission safe；沿用分页；不改变写操作）
- Attention 优先前端组合现有 List API；实测无 N+1（28 房规模 4 个批量请求），
  不新增 `GET /front-desk/attention`
- 页面数据 = `GET /rooms` + `GET /reservations?overlap_*` + `GET /stays?status=ACTIVE`
  + `GET /housekeeping/tasks`（各循环翻页拉全，page_size=100）；Room Drawer 的
  next reservation 为抽屉打开时的一次定向请求，不构成页面级 N+1
- 不引入 microservice / Redis / event bus / WebSocket / cache layer

## 6. 复用清单（REUSE FIRST）

| 能力 | 复用来源 |
| --- | --- |
| 预订创建/编辑/取消/No-show/Check-in | Sprint 2 `/reservations` API + ReservationForm（仅加 prefill prop） |
| 退房（Check-out） | Sprint 2 `/stays/[id]` 详情（Front Desk 不复制退房逻辑） |
| 保洁任务/状态机 | Sprint 3 `/housekeeping` 全部能力（只读消费） |
| 可售性验证 | `GET /availability`（快速新建仍重新验证） |
| 权限/PII 裁剪 | Sprint 2 REV-02 / REV-FINAL-04 后端裁剪契约 |
| 日期算术 | `lib/booking.ts` businessDate / addDays（Asia/Shanghai） |
| UI 基座 | AppShell / StatusBadge / ConfirmDialog / Loading/Error/Forbidden / booking/shared |

## 7. 验收（Definition of Done）

1. 28 房未来 1/7/14/30 天 Room Diary 可用
2. Today Summary 清楚显示 Arrivals / Departures / In-house / Vacant Clean / Attention
3. Reservation Drawer 支持主要前台操作
4. 点击空白日期快速新建并正确预填
5. Occupancy + Cleaning + Reservation + Housekeeping 同台清晰组合
6. Desktop Room Diary 与 Mobile Today Board 都真正可用
7. RBAC / PII 边界正确
8. Sprint 1–3 无回归
9. pytest / Vitest / Playwright 全绿
10. Clean Bootstrap PASS（empty stayops_test → alembic upgrade head → seed →
    setup users → FastAPI :8001 → Next.js :3001 → Full Playwright）

## 8. 测试基线（不得删除 / skip / fixme / 弱化旧测试）

- pytest：202 基线 + overlap 窗口查询 11 条（overlap / non-overlap / adjacent /
  boundary / invalid range / permission / PII search / pagination / status 组合）
  + D1 死锁窄分类 7 条（commit/flush 处 40P01、40001 → 409；update 路径映射；
  57014 与无 pgcode OperationalError → 原异常传播 + 事务回滚验证；
  25 轮真实并发双订无 500）
- Vitest：170 基线 + 70 条（timeline [ci,co) 几何 / Today Summary / Attention 三规则 /
  Reservation & Room Drawer / quick create prefill / filters / search / PII hiding /
  permission gating / Housekeeping integration / responsive Today Board / 导航矩阵）
- Playwright：36 基线 + 10 条（28 房 Diary / Golden Path 全链路 / 相邻预订 /
  Attention 三规则 / Housekeeping 完成闭环 / 搜索定位 / PII / RBAC / Mobile / Tablet）

## 9. Git 规则

本 Sprint：NO COMMIT / NO PUSH / NO TAG / NO RELEASE。
全部完成后等待 Kun Fast QA，由 Kun 决定 Release 与 `v1.0.0-alpha.4`。
