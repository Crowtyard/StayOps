# StayOps Tests

> 测试按层组织：
> - 后端 pytest：`backend/tests/`（649 用例，独立测试库 `stayops_test`）
> - 前端单元/组件测试（Vitest）：`frontend/src/**/__tests__/`（462 用例 / 59 文件）
> - 端到端测试（Playwright）：`frontend/e2e/`（80 用例，独立 `stayops_test` 库 + 专用端口）
> - 桌面测试（Vitest）：`desktop/src/**/__tests__/`（68 用例）
>
> （计数为 `v1.0.0-alpha.9.4` 实测值；Sprint 8 基线 379 / 379 / 64 全部保留）

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
