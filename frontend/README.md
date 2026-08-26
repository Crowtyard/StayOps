# StayOps Frontend

StayOps V1.0 前端：Next.js 16（App Router）+ TypeScript（strict）+ Tailwind CSS 4。

## 技术要点

- **认证**：HttpOnly Cookie + BFF。`POST /api/auth/login` 转发后端登录并把 JWT 写入 `stayops_token` Cookie（httpOnly / sameSite=lax / path=/，生产 secure）；浏览器代码不接触 Token。
- **API 访问**：所有后端接口统一走 `app/api/bff/[...path]/route.ts` 通用代理（服务端读 Cookie 附加 `Authorization: Bearer` 转发到 `BACKEND_API_URL`）。
- **API Client**：`src/lib/api/`（client.ts + auth/rooms/room-types/users/roles/permissions/audit-logs 模块），统一错误归一化（401/403/404/409/422/5xx/network → `ApiError`，消息可读）。
- **权限**：后端 RBAC 强制校验（前端仅按权限隐藏入口，不作为安全边界）；403 显示“无权限”，不与登录失效混淆。

## 本地开发

```powershell
pnpm.cmd install
Copy-Item .env.example .env.local   # BACKEND_API_URL=http://127.0.0.1:8000
pnpm.cmd dev                        # http://localhost:3000
```

后端需先运行：`uvicorn app.main:app --port 8000`（见 backend/）。

## 质量命令

```powershell
pnpm.cmd lint        # ESLint
pnpm.cmd typecheck   # tsc --noEmit（strict）
pnpm.cmd test        # Vitest 单元/组件测试（jsdom + Testing Library）
pnpm.cmd build       # 生产构建
pnpm.cmd test:e2e    # Playwright E2E（独立 stayops_test 库，见下文）
```

## Playwright E2E（不触碰开发数据）

E2E 使用独立测试库 `stayops_test` 与专用端口（后端 `127.0.0.1:8001`、前端 `localhost:3001`），
`playwright.config.ts` 的 webServer 会自动重建测试库（迁移 + 28 间种子房）并启动两个专用实例，测试结束自动清理。

```powershell
# 首次：准备凭据文件（已被 .gitignore 忽略，禁止入库）
Copy-Item e2e\test-creds.example e2e\.env.test-creds   # 填入测试库 admin 密码等
pnpm.cmd test:e2e
```

用例覆盖：管理员登录→Dashboard→房态 28 房→合法状态修改→刷新保持、blocked 确认框、
FRONT_DESK/HOUSEKEEPING 导航收窄 + 直连 403 + 无权限 UI、退出后守卫、四个管理页真实读取、房态变更→审计真实记录。

## 页面

| 路由 | 说明 |
|---|---|
| /login | 登录（失败提示“用户名或密码错误”） |
| /dashboard | 当前房态概览（真实 /rooms 数据实时计算） |
| /rooms | 房态卡片棋盘（双维度状态、楼层/房型/占用/清洁筛选） |
| /rooms/[id] | 房间详情 + 状态修改（真实状态机，blocked/out_of_service 需确认） |
| /settings/users | 用户管理（创建/编辑/启用停用/分配角色/删除） |
| /settings/roles | 角色与权限（CRUD + 权限查看与修改，role:write 可改） |
| /settings/room-types | 房型管理（CRUD，删除有房间房型显示后端 409） |
| /settings/audit-logs | 审计日志（操作类型/资源类型筛选 + details 展开，不整块 JSON 塞表格） |

## 目录结构

```text
src/
  app/
    api/auth/{login,logout,me}/route.ts   # 认证 BFF
    api/bff/[...path]/route.ts            # 通用后端代理
    (main)/layout.tsx                     # 受保护布局（登录守卫 + 导航壳）
    (main)/{dashboard,rooms,rooms/[id]}   # 业务页面
    (main)/settings/{users,roles,room-types,audit-logs}  # 管理页面
  components/                             # 导航壳/Drawer/状态徽标/对话框/状态视图
  components/settings/                    # 管理页视图与共享工具
  lib/api/                                # 统一 API Client
  lib/server/                             # 服务端 Cookie 读取与后端直连
e2e/                                      # Playwright E2E（配置/用例/测试库准备脚本）
vitest.config.mts                         # Vitest 配置（jsdom）
playwright.config.ts                      # Playwright 配置（webServer 拉起专用前后端）
```
