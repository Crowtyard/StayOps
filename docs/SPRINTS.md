# Sprint 1

## 技术栈

```text
Frontend    Next.js
            TypeScript

Backend     FastAPI
            Python

Database    PostgreSQL

Deployment  Docker Compose
```

## Sprint 1 只开发

```text
登录
用户
角色
RBAC 权限
房型
房间
Audit Log
```

## 预计数据表

```text
users
roles
permissions
user_roles
rooms
room_types
audit_logs
```

## 初始角色

```text
SUPER_ADMIN
MANAGER
FRONT_DESK
HOUSEKEEPING
MAINTENANCE
FINANCE
```

## 后续

初始化 28 个测试房间（对应济南历下区 CBD 项目约 28 间客房）。

## Sprint 1 进度（截至 T3a）

- ✅ T1：环境准备（Docker Compose / PostgreSQL / FastAPI 骨架 / 种子数据）
- ✅ T2：认证 + RBAC + 业务 API + 房态双维度状态机 + 审计（28 间种子房）
- ✅ T3a：前端核心链路——Next.js 16 + TS strict + Tailwind；认证 BFF（/api/auth/*，HttpOnly Cookie）+ 通用代理（/api/bff/*）；统一 API Client；权限化统一 Layout（侧边导航/顶栏/手机 Drawer）；/login、/dashboard（真实房态概览）、/rooms（双维度棋盘+筛选）、/rooms/[id]（真实状态机修改+确认框）；Loading/Empty/Error 与离线态。质量：`pnpm lint` / `pnpm typecheck` / `pnpm build` 全过；curl 冒烟真实复验通过（登录→HttpOnly Cookie→me→28 间房→详情→合法/非法状态转换→审计链路、RBAC 403、401/403 区分、离线 502）。Playwright 冒烟**尚未实施**（仓库无 Playwright 配置或测试文件，此前“Playwright 冒烟全过”的描述不实，已更正），归入 T3b。
- ✅ T3b：管理页面 + 前端测试体系——/settings/users（创建/编辑/启用停用/分配角色/删除）、/settings/roles（CRUD + 权限查看与修改，role:write 可改权限）、/settings/room-types（CRUD，删除有房间房型显示后端 409）、/settings/audit-logs（操作类型/资源类型筛选 + details 展开，不整块 JSON 塞表格）；导航移除 T3b 占位角标；403 统一“无权限访问该页面”且不跳登录。Vitest（jsdom + Testing Library）：11 个测试文件 74 条用例全过（Auth 登录成功/失败/网络、RBAC 导航显隐、Rooms 28 房展示/reserved+dirty 双维度/合法与非法转换/确认框、Audit 展开与筛选、四个 Settings 视图）。Playwright E2E 正式入库（10 条用例，独立 stayops_test 库 + 专用后端 127.0.0.1:8001 + 前端 localhost:3001，不碰 dev 数据）：管理员登录→Dashboard→房态→28 房→合法状态修改→刷新保持、blocked 确认框、FRONT_DESK/HOUSEKEEPING 导航收窄 + 直连 403 + 无权限 UI、退出后守卫、四个管理页真实读取、房态变更→审计日志真实记录。质量门禁：`pnpm lint` / `pnpm typecheck` / `pnpm test`（Vitest 74 用例）/ `pnpm build` / `pnpm test:e2e`（Playwright 10 用例）/ 后端 `pytest`（87 用例）全部通过。

## Sprint 1 Release Baseline

Status: FINAL ACCEPTANCE PASS

Final Acceptance Commit:

a8b13ce2d00f1e8d48512d57fba93e56506d8e07

Release:

v1.0.0-alpha.1

Sprint 1 is frozen as the first stable StayOps development baseline.

Future development must build on top of this baseline through subsequent commits.

## Sprint 2（COMPLETE）

```text
Sprint 2                = COMPLETE
正式名称                = Booking & Stay Core Flow（预订、入住与退房核心链路）
Release                 = v1.0.0-alpha.2（RELEASED）
Sprint 2 PRD            = FINAL
Sprint 2 Task Spec      = APPROVED
Sprint 2 Coding         = COMPLETE（S2-T1、S2-T2、S2-T3 全部完成）
S2-T1                   = COMPLETE · QA PASS · CHECKPOINTED
S2-T2                   = COMPLETE · QA PASS · CHECKPOINTED
S2-T3                   = COMPLETE · QA PASS · CHECKPOINTED
Sprint 2 Final Acceptance = PASS
DSH                     = IDLE
Kun                     = PROJECT MANAGER + QA
```

任务书（docs/tasks/sprint-02/）：

- README.md — 总纲：Golden Path、不可违反架构规则、RBAC、错误语义、Out of Scope、回归基线、Git 规则
- S2-T1.md — Booking Domain Foundation（后端）
- S2-T2.md — Booking Operations UI（前端）
- S2-T3.md — Integration & E2E（全链路验收）

Sprint 2 进展：S2-T1（Booking Domain Foundation）、S2-T2（Booking Operations UI）、S2-T3（Integration & E2E）全部完成并通过独立 QA；Sprint 2 Final Acceptance PASS（pytest 167 / Vitest 139 / Playwright 29 全绿）；`v1.0.0-alpha.1` 冻结不动，`v1.0.0-alpha.2` 已创建为 Sprint 2 Release Commit。

## Sprint 3（COMPLETE）

```text
Sprint 3                = COMPLETE
正式名称                = Housekeeping Operations & Room Turnover（保洁运营与翻房闭环）
Release                 = v1.0.0-alpha.3（RELEASED）
开发模式                = FAST TRACK + REUSE FIRST + ONE SPRINT / ONE DSH SESSION
Sprint 3 Coding         = IMPLEMENTATION COMPLETE（单会话一次完成）
Sprint 3 Fast QA        = PASS（Kun 独立重跑 pytest 202 / Vitest 170 / Playwright 36 全绿）
DSH                     = STOPPED
Kun                     = PROJECT MANAGER + QA
```

任务书：`docs/tasks/sprint-03/README.md`（单文档，不再拆分 S3-T1/T2/T3）。

Sprint 3 范围：退房自动生成 Housekeeping Task（同一事务）→ 派单 → 开始清扫 → 提交验房 → 通过/返工 → 房间翻房闭环；Active Task 数据库级唯一（部分唯一索引）；Task 状态与 Room.cleaning_status 原子联动；保洁工作台（`/housekeeping` / `/housekeeping/[id]`）；Dashboard 与 Room Detail 集成；Check-in clean gating 保持；保洁域 RBAC / 审计 / 并发安全 / 无 PII。

Sprint 3 进展：DSH 单会话完成全部实现（Implementation Complete，无 commit）；Kun Fast QA 独立重跑正式测试全绿（pytest 202 / Vitest 170 / Playwright 36，Sprint 2 基线 167 / 139 / 29 全部保留），代码审查确认 Checkout 原子性、Active Task 数据库级部分唯一索引、Task ↔ Room 原子联动、RBAC / PII / Check-in gating；`v1.0.0-alpha.2` 冻结不动，`v1.0.0-alpha.3` 已创建为 Sprint 3 Release Commit。

## Sprint 4（COMPLETE）

```text
Sprint 4                = COMPLETE
正式名称                = Front Desk Command Center & Room Diary（前台运营指挥台与房态日历）
Release                 = v1.0.0-alpha.4（RELEASED）
开发模式                = FAST TRACK + REUSE FIRST + ONE SPRINT / ONE DSH SESSION（不拆 T1/T2/T3）
Sprint 4 Coding         = IMPLEMENTATION COMPLETE（单会话一次完成）
Sprint 4 Fast QA        = PASS（Kun 独立重跑 pytest 220 / Vitest 240 / Playwright 46×2 全绿 + D1 修复复审）
DSH                     = STOPPED
Kun                     = PROJECT MANAGER + QA
```

任务书：`docs/tasks/sprint-04/README.md`（单文档，不拆 S4-T1/T2/T3）。

Sprint 4 范围：`/front-desk` 前台运营工作台 —— Today Summary（到店/离店/在住/空净房/需关注，卡片点击进右侧 Drawer）；Room Diary（28 房 × 1/7/14/30 天时间线，楼层分组 + 楼层/房型筛选，左侧房间栏 sticky，双状态占用+清洁不合并，时间线严格 `[check_in, check_out)` 无 off-by-one）；Reservation Drawer（Check-in/Edit/Cancel/No-show/Full Detail，全部复用 Sprint 2 API；脏房到店明确显示「房间尚未准备完成」+ 保洁任务）；点击空白日期格快速新建（复用 `/reservations/new` 预填，Availability 仍重新验证）；统一搜索（房号/Guest name/phone/reservation_no，PII 受 guest:read 约束）；Attention Center 三条固定规则（脏房到店 / 超期在住 / 锁房未来预订）；Room Quick View；Housekeeping 集成（只消费 Alpha.3）；Mobile（<768px FrontDeskTodayBoard，不渲染完整 Room Diary）；Backend 最小扩展 `overlap_from` / `overlap_to`（Reservation List 日期窗口重叠查询，只读）；写操作后 targeted refetch + 60s 轮询。Alpha.4 不做拖拽排房。

Sprint 4 进展：DSH 单会话完成全部实现（Implementation Complete，无 commit）；Kun Fast QA 第一轮 FAILED（Blocking Defect D1：并发双订偶发 DeadlockDetected 逃逸 500），DSH 已修复并按 Fast Review 收窄分类（仅 23P01/40P01/40001 → 409，其它 OperationalError 原样 re-raise）；Kun Fast QA 复审（S4-D1 Re-QA）PASS：pytest 220 / Vitest 240 / Playwright 连续两轮 46 全绿，独立并发压测 100 轮（50 服务层 + 50 真实 HTTP）0 × 500 且每轮 exactly 1 条；`v1.0.0-alpha.3` 冻结不动，`v1.0.0-alpha.4` 已创建为 Sprint 4 Release Commit。
