# StayOps Frontend

StayOps V1.0 前端：Next.js 16（App Router）+ TypeScript（strict）+ Tailwind CSS 4。

## 技术要点

- **认证**：HttpOnly Cookie + BFF。`POST /api/auth/login` 转发后端登录并把 JWT 写入 `stayops_token` Cookie（httpOnly / sameSite=lax / path=/，生产 secure）；浏览器代码不接触 Token。
- **API 访问**：所有后端接口统一走 `app/api/bff/[...path]/route.ts` 通用代理（服务端读 Cookie 附加 `Authorization: Bearer` 转发到 `BACKEND_API_URL`）。
- **API Client**：`src/lib/api/`（client.ts + auth/rooms/room-types/users/roles/permissions/audit-logs 模块），统一错误归一化（401/403/404/409/422/5xx/network → `ApiError`，消息可读）。
- **权限**：后端 RBAC 强制校验（前端仅按权限隐藏入口，不作为安全边界）。

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
pnpm.cmd build       # 生产构建
```

## 页面

| 路由 | 说明 |
|---|---|
| /login | 登录（失败提示“用户名或密码错误”） |
| /dashboard | 当前房态概览（真实 /rooms 数据实时计算） |
| /rooms | 房态卡片棋盘（双维度状态、楼层/房型/占用/清洁筛选） |
| /rooms/[id] | 房间详情 + 状态修改（真实状态机，blocked/out_of_service 需确认） |

`/settings/*`（用户/角色与权限/房型/审计日志）在 T3b 实现；导航已按权限预留入口。

## 目录结构

```text
src/
  app/
    api/auth/{login,logout,me}/route.ts   # 认证 BFF
    api/bff/[...path]/route.ts            # 通用后端代理
    (main)/layout.tsx                     # 受保护布局（登录守卫 + 导航壳）
    (main)/{dashboard,rooms,rooms/[id]}   # 业务页面
  components/                             # 导航壳/Drawer/状态徽标/对话框/状态视图
  lib/api/                                # 统一 API Client
  lib/server/                             # 服务端 Cookie 读取与后端直连
```
