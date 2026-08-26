# StayOps 架构

## 顶层架构

- `frontend/` — Next.js 16 + TypeScript（strict）+ Tailwind 前端
- `backend/` — FastAPI + Python 后端
- `infra/docker/` — Docker 部署配置
- `docs/` — 项目文档
- `tests/` — 测试

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

## 前端结构（T3a）

```text
frontend/src/
  app/
    api/auth/{login,logout,me}/route.ts   # 认证 BFF（Cookie 读写）
    api/bff/[...path]/route.ts            # 通用代理（透传状态码与 detail）
    login/page.tsx                        # 登录页
    (main)/layout.tsx                     # 受保护布局：服务端登录守卫 + AppShell
    (main)/dashboard|rooms|rooms/[id]     # 首页概览 / 房态棋盘 / 房间详情
  components/                             # AppShell(侧边导航+顶栏+手机Drawer)、状态徽标、
                                          # 确认对话框、Loading/Empty/Error 视图
  lib/api/                                # 统一 API Client（client.ts + 各资源模块 + 错误归一化）
  lib/server/                             # 服务端 Cookie 读取 / 后端直连 Client
```

- 页面数据由 Client Component 在挂载后经 `/api/bff` 拉取（Loading/Empty/Error 三态）；
  登录态由服务端布局读取 Cookie 校验（未登录 307 → /login）
- 导航按 `auth/me` 返回的权限 code 动态显示；`/settings/*` 页面在 T3b 实现（导航已预留）

## 原则

- 前后端分离，通过 REST API 通信
- 业务权限在后端验证（前端隐藏按钮不算权限控制）
- 数据库 Schema 变更一律使用 Migration
- 重大架构决策记录到 `DECISIONS.md`
