# StayOps Tests

> 测试按层组织：
> - 后端 pytest：`backend/tests/`（804 用例，独立测试库 `stayops_test`）
> - 前端单元/组件测试（Vitest）：`frontend/src/**/__tests__/`（498 用例 / 62 文件）
> - 端到端测试（Playwright）：`frontend/e2e/`（84 用例，独立 `stayops_test` 库 + 专用端口）
> - 桌面测试（Vitest）：`desktop/src/**/__tests__/`（84 用例 + 1 条默认跳过的真实集成测试）
>
> （计数为 `v1.0.0-alpha.9.6` 实测值；Sprint 8 基线 379 / 379 / 64 全部保留）

## alpha.9.6 新增测试（Field Trial Operations Improvements）

| 层 | 文件 | 覆盖 |
|---|---|---|
| Backend | `tests/test_alpha96_migration.py` | alpha.9.4 真实 schema → head：28 房与全部 reservation 保留、7 种 legacy source 逐值回填、空库升级、幂等、单 head、downgrade 往返、mapping 穷尽性 |
| Backend | `tests/test_room_management.py` | 房间新增/编辑/重复房号/停用/启用/summary/历史房间删除保护/停用房可售性/RBAC |
| Backend | `tests/test_channels.py` | 渠道默认值/自建/编辑/停用/重名策略/系统渠道保护/删除保护/RBAC/seed 与 migration 一致性 |
| Backend | `tests/test_room_status_by_date.py` | 某日房态 resolver：无预订可售、未来预订、多晚、退房边界、在住、维修 override、停用房排除、分区不变式、与可售性引擎对拍、参数校验 |
| Backend | `tests/test_reservation_channel.py` | source_channel 持久化、非法/停用渠道、legacy 入站映射、冲突以渠道为准、只读投影一致性、RBAC |
| Backend | `tests/test_channel_analytics.py` | 渠道订单数/房晚/合同房费/占比/ADR、取消与未到店排除、换房防重复计数、自建渠道、未指定渠道对账、零数据、权限、区间校验、PII 扫描 |
| Backend | `tests/test_ai_channel_compat.py` | AI 工具层 `get_analytics(channels)`、`ai_channels` 视图、域白名单、既有 analytics 不受影响 |
| Frontend | `__tests__/rooms-management-view.test.tsx` | 房间资料管理 UI（数量统计/新增/编辑/停用/后端 409 文案/权限门控） |
| Frontend | `__tests__/dashboard-room-status-date.test.tsx` | 首页按日期房态（默认今天/前后一天/日期选择器/未来日期提示/分类钻取） |
| Frontend | `__tests__/channels-view.test.tsx` | 渠道管理 UI + 渠道经营分析表格（含合计对账、零数据、权限） |
| E2E | `e2e/field-trial-alpha96.spec.ts` | 4 条真实端到端流程（见任务书 §12） |

## alpha.9.6 Windows runtime hotfix 新增测试（非 ASCII 安装路径）

| 层 | 文件 | 覆盖 |
|---|---|---|
| Desktop | `runtime/__tests__/pgRuntime.test.ts` | PG runtime resolver：development 行为不变、materialize 到 ASCII-safe 版本化路径、幂等复用、半复制/损坏 runtime 不复用、staging 残留清理、不触碰 data 目录、缺 runtime/无法识别版本/非 ASCII 目标 → Fail Safe、版本探测（marker 优先 / binary 回退）、PG 工具全覆盖、marker 不含开发机路径 |
| Desktop | `runtime/__tests__/pgRuntime.integration.test.ts` | **真实集成（默认跳过，`STAYOPS_PG_INTEGRATION=1` 运行）**：非 ASCII 源路径 `D:\测试目录\StayOps\resources\postgres\pgsql` → materialize 到 `C:\ProgramData\StayOps\runtime\postgresql\<version>\pgsql` → 真实 `initdb -E UTF8 --locale=C` PASS |
| Backend | `tests/test_desktop_runtime_pg.py` | `decode_pg_output` 三级解码（UTF-8 / system preferred / replacement，乱码与非法字节）、data 目录五态判定、失败初始化标记必须在 data 目录**之外**、部分初始化清理守卫（无 PG_VERSION 才可清理、有 PG_VERSION 永不删）、`db-ensure` 拒绝未知非空目录、备份工具同一 resolver（忽略半复制 runtime） |
| Backend | `tests/test_desktop_runtime_pg_integration.py` | **真实集成（默认跳过，`STAYOPS_PG_INTEGRATION=1` 运行）**：真实 `cmd_db_ensure` 全新初始化（initdb → pg_ctl start → 建库）、第二次调用幂等、有 PG_VERSION 时清理守卫必须拒绝 |

## 后端 pytest

```powershell
cd backend
.venv\Scripts\python.exe -m pytest -q
```

会话级重建测试库 `stayops_test`（DROP/CREATE → alembic upgrade → 幂等 seed），用例级事务回滚隔离。

## 前端 Vitest

```powershell
cd frontend
pnpm.cmd test        # vitest run（jsdom + Testing Library）
pnpm.cmd test:watch  # watch 模式
```

## Playwright E2E（真实 FastAPI，禁止 Mock）

```powershell
cd frontend
# 首次：准备凭据（gitignored，禁止入库）
Copy-Item e2e\test-creds.example e2e\.env.test-creds   # 填入测试库凭据
pnpm.cmd test:e2e
```

`playwright.config.ts` 的 webServer 自动完成：
1. `e2e/run_test_backend.py`（单进程）：`prepare_test_db.py` 重建 `stayops_test`（迁移 + 28 间种子房）→ 在本进程内于 `127.0.0.1:8001` 启动 FastAPI
2. `node node_modules/next/dist/bin/next dev -p 3001`（`BACKEND_API_URL=http://127.0.0.1:8001`，`NEXT_DIST_DIR=.next-e2e`）
3. `setup-users.ts`：在测试 `beforeAll` 中以 admin 直连后端创建 FRONT_DESK / HOUSEKEEPING 测试账号（幂等）
4. 单 worker 串行执行全部用例；测试结束 webServer 自动停止

E2E 完全不触碰开发环境（`127.0.0.1:8000` / `localhost:3000`）。
