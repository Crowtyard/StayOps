# Sprint 1 T3 任务书（前端实现与全栈链路打通）

> 由 DSH Agent 执行。执行前必须阅读：AGENTS.md、docs/PRD.md、docs/SPRINTS.md、docs/ARCHITECTURE.md、docs/DATABASE.md、docs/API.md、docs/DECISIONS.md、docs/ENVIRONMENT_CHECK.md。
> 以 backend 当前 OpenAPI（`http://127.0.0.1:8000/openapi.json`，后端已按验收状态运行）为接口唯一依据，禁止凭旧文档猜接口。

## 核心目标

打通：登录 → 认证 → 读取当前用户 → RBAC 显示界面 → 读取房间 → 房间详情 → 修改占用状态 → 修改清洁状态 → 后端写 Audit Log → 前端得到真实结果。同时完成用户/角色/权限/房型/审计页面。达到"真实员工可通过浏览器完成 Sprint 1 主要业务操作"。

## 技术栈与工程要求

- Next.js 16（App Router）+ TypeScript **strict: true** + Tailwind CSS
- pnpm（Windows 下用 `pnpm.cmd`，PowerShell 执行策略限制 .ps1）
- 目录：`frontend/`（当前仅有 README.md 占位）
- 状态管理：不引入 Redux/MobX；用 React + Server Components + 必要时轻量 Client Components
- UI 组件：Tailwind 手写组件或 shadcn/ui 风格源码组件；**不引入重组件库、不付费组件、不用来路不明组件**；选择记录到 docs/DECISIONS.md
- 视觉：现代 SaaS 简洁后台；不做花哨渐变/玻璃拟态/游戏 UI；状态靠"文字+颜色"双通道，不能只靠颜色；响应式（手机端左侧导航收成 Drawer）

## 认证架构（重点）

后端只发 Bearer Token（HTTPBearer）。采用 **HttpOnly Cookie + BFF**：

```
Browser → Next.js Route Handler（/api/auth/* 与 /api/bff/*）→ FastAPI（127.0.0.1:8000）
```

- `POST /api/auth/login`（Route Handler）：转发 `POST /api/v1/auth/login`，成功后把 access_token 写入 **HttpOnly Cookie**（httpOnly=true, sameSite=lax, path=/；生产 secure=true）
- `POST /api/auth/logout`：清 Cookie
- `GET /api/auth/me`：读 Cookie → 调 `/api/v1/auth/me` 返回用户+角色+权限
- 其余后端 API：前端统一经 `app/api/bff/[...path]/route.ts` 代理转发（服务端读 Cookie 附加 `Authorization: Bearer`），**浏览器端不接触 Token**
- 禁止：localStorage 存 JWT、把 token 打印到 console/日志、NEXT_PUBLIC_ 放任何密钥
- 401 时前端清状态跳 /login；403 显示"无权限"，不得误判为登录失效

## 环境变量

- `frontend/.env.example`：
  - `BACKEND_API_URL=http://127.0.0.1:8000`（服务端内部地址，非 NEXT_PUBLIC）
  - `NEXT_PUBLIC_APP_NAME=StayOps V1.0`（仅展示用）
  - 真实 .env 由 .env.example 复制（本地开发），`.env*` 已被根 .gitignore 忽略

## API Client

`frontend/src/lib/api/`：client.ts（fetch 封装：BaseURL、Cookie、JSON、超时、错误归一化）+ 模块（auth/users/roles/permissions/room-types/rooms/audit-logs）。统一错误类型：401/403/404/422/500/network，错误消息对用户可读（不显示 stack trace）。

## 页面（App Router）

| Route | 功能 | 权限 |
|---|---|---|
| /login | 登录表单（用户名/密码；失败显示"用户名或密码错误"） | 公开 |
| /dashboard | 当前房态概览（真实 /rooms 数据计算：总房/可售/已预订/在住/锁房/停用/待清扫/清扫中/待检查；明确标注"当前房态概览"；禁止伪造营业额/ADR/RevPAR） | 登录 |
| /rooms | 房态卡片棋盘（每房：房号+房型+占用状态+清洁状态，文字+颜色）；筛选：全部/楼层/房型/占用状态/清洁状态（后端筛选优先） | room:read |
| /rooms/[id] | 房间详情：房号/房型/楼层/双状态/备注/创建时间/更新时间；有权限时修改占用状态与清洁状态（调真实 API，非法转换显示后端错误）；blocked/out_of_service 变更前确认 | room:read（操作按权限） |
| /settings/users | 用户列表/创建/编辑/启用停用/分配角色 | user:* |
| /settings/roles | 角色列表/描述/权限列表；SUPER_ADMIN 可改权限（按后端能力） | role:* |
| /settings/room-types | 房型 CRUD（按后端能力） | room_type:* |
| /settings/audit-logs | 审计列表（时间/用户/Action/Resource/IP；details 展开查看，不整块 JSON 塞表格） | audit:read |

- 统一 Layout：左侧导航（首页/客房-房态、房型/系统-用户、角色与权限、审计日志）+ 顶栏（用户名/角色/退出）；**不显示**保洁/维修/库存/采购/经营分析/AI 店长
- 导航与按钮按权限动态显示（SUPER_ADMIN 全显；FRONT_DESK 只显房态；HOUSEKEEPING 只能改 cleaning_status；MAINTENANCE 按后端实际权限）——前端仅改善 UI，安全靠后端 RBAC
- 未登录访问受保护页 → 跳 /login；刷新 /rooms/[id] 不 404/白屏
- 每个主要页面有 Loading / Empty / Error（Error 含"重新加载"；后端不可达显示"服务暂时不可用"）
- 可访问性：按钮键盘可用、表单有 label、Dialog 可关闭、错误可读

## 测试

- 前端单测/组件测试（Vitest + Testing Library 或项目等价）：Auth（登录成功/失败/未认证跳转/退出）、RBAC（SUPER_ADMIN 见角色管理、FRONT_DESK 不见、403 提示）、Rooms（28 房间展示、双维度显示、reserved+dirty 正确、合法修改成功、非法转换显示错误）、Audit（有权限加载）
- Playwright E2E（独立测试库 stayops_test 或专门 E2E 库，不碰 dev 数据）：
  1. 管理员登录 → Dashboard → 房态 → 看到房间
  2. 打开测试房间 → 合法状态修改 → 页面更新 → 刷新后仍正确
  3. FRONT_DESK 登录 → 看不到角色管理 → 直接请求无权限功能 → 403 且 UI 正确提示
- E2E 连接真实 FastAPI，禁止 Mock 冒充成功

## 质量门槛（必须全过）

```powershell
pnpm lint
pnpm typecheck        # 或 pnpm tsc --noEmit
pnpm test
pnpm build            # 禁止 ignoreBuildErrors 绕过
```

## 文档更新

README.md、docs/ARCHITECTURE.md、docs/API.md、docs/DECISIONS.md（UI 技术选择、Auth 方案记录）、docs/SPRINTS.md：前端结构、Auth 方案、API Client、RBAC UI、页面列表、测试方法、启动方法（前后端分别启动：backend `uvicorn app.main:app --port 8000`；frontend `pnpm dev`）。

## 边界

禁止提前实现：保洁任务系统、维修工单、库存、采购、经营收入/ADR/RevPAR、OTA、CRM、AI 店长。cleaning_status 仅是房间字段，不扩展为保洁系统。

## 环境提示

- 后端已运行在 127.0.0.1:8000（dev CORS 已开）；数据库 postgres 容器 healthy
- 测试账号：admin / Admin@123456（SUPER_ADMIN）；可自建 FRONT_DESK/HOUSEKEEPING/MAINTENANCE 测试用户（API 支持创建+分配角色）
- pnpm 用 `pnpm.cmd`；npm registry 可用
- 完成后按 AGENTS.md 报告：修改文件、主要实现、API 变化、测试命令与结果、已知问题；**不要自行 git commit**（Kun 验收后统一提交）
