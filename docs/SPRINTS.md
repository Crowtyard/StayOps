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
- ⏳ T3b：/settings/users、/settings/roles、/settings/room-types、/settings/audit-logs 页面 + 前端单测（Vitest）+ Playwright E2E 入库（stayops_test：管理员登录→Dashboard→房态→测试房间合法状态修改→刷新校验、FRONT_DESK 无权限入口与 403 UI 等正式用例）
