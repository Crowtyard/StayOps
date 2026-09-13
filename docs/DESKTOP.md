# StayOps Desktop（Windows 桌面客户端）— Desktop D1

> 版本：v1.0.0-alpha.9.3（Desktop D1 里程碑）
> 状态：v1.0.0-alpha.9.3 已发布（Formal Release Gate 全绿，验证结果见 §10）

## 1. 是什么

StayOps Desktop 把 StayOps 封装为可双击使用的 Windows 客户端：

```
Windows Explorer
  ↓ 双击 StayOps.exe
  ↓ 启动窗口立即出现（自动检查 Runtime）
  ↓ 检查 PostgreSQL → 检查 Alembic → 启动 FastAPI Production → 启动 Next.js Production
  ↓ 打开 StayOps Desktop Window → 登录使用
```

普通使用过程中**不需要**打开 PowerShell / CMD / Git Bash / VS Code。

架构保持不变：

```
Electron
  ↓
Next.js Production UI（standalone，127.0.0.1:3100）
  ↓ BFF（/api/bff/*，服务端代理，HttpOnly Cookie）
FastAPI（uvicorn production，127.0.0.1:8100）
  ↓
PostgreSQL
```

Electron 只负责：桌面窗口、启动 UX、Runtime lifecycle、本地进程监督。
**Electron 不直接查询 PostgreSQL、不解析 Alembic、不读取任何 .env 秘密。**

## 2. Development Mode vs Desktop Mode

| | Development Mode | Desktop Mode |
|---|---|---|
| 入口 | `start-dev.cmd`（scripts/dev_runtime.py） | 双击 `desktop/dist/win-unpacked/StayOps.exe` |
| 前端 | `next dev`（3000） | Next standalone production（3100） |
| 后端 | `uvicorn --reload`（8000） | uvicorn production，NO --reload（8100） |
| 数据库 | stayops（alembic current==head 检查） | 同 stayops，额外多 head Fail Safe |
| 进程 | Supervisor 统一管理 | Electron 主进程监督（自持进程树） |
| 弹窗 | 终端可见 | 全程零控制台弹窗 |

两个模式互不影响：桌面使用独立 loopback 端口（3100/8100）与独立构建目录
（`frontend/.next-desktop`），开发模式照常运行。

## 3. Runtime Lifecycle

启动窗口显示 6 步状态：检查运行环境 → 检查端口 → 连接数据库 → 检查数据库版本
→ 启动后端 → 启动前端 → 进入 StayOps。

```
env（venv python / node / standalone server.js 存在性）
  → ports（3100/8100 未被未知进程占用；占用则报错并显示 PID，绝不 kill）
  → database（SELECT 1 经 backend/.venv 的 Python 探针）
  → migration（alembic current vs heads；多 head 直接 Fail Safe）
  → backend（spawn venv python backend/scripts/desktop_backend_runner.py，
            等待 /health + OpenAPI 核心路由）
  → frontend（spawn node <standalone>/server.js，等待 /login 200）
  → ready（打开 1440×900 主窗口，关闭启动窗口）
```

任何一步失败 → 启动窗口切换到错误视图：

```
StayOps 无法启动
<人类可读错误>
[重新检查] [打开日志目录] [退出 StayOps]
```

覆盖：Python missing / PostgreSQL unavailable / config missing / port occupied /
migration mismatch / backend failed / frontend failed / workspace not found。

### 迁移（Alembic）安全

- 启动**只检查** `alembic current` / `alembic heads`，**绝不静默 upgrade**。
- 数据库落后 → 显示「数据库需要升级：当前版本 → 目标版本」
  [升级数据库并继续] [退出]；只有用户点击后才执行 `alembic upgrade head`。
- 多 head → Fail Safe 报错，不执行任何升级。
- 从不自动 downgrade。

## 4. 前置条件（D1）

D1 依赖当前这台机器：

- Windows 10/11 x64
- StayOps 工作区（`backend/.venv/Scripts/python.exe` 存在；可用环境变量
  `STAYOPS_ROOT` 覆盖工作区路径，默认候选 `D:\MY SELF\StayOps V1.0`）
- 本机 PostgreSQL 服务运行中（配置见 `backend/.env` 的 `DATABASE_URL`）
- Node.js（`next start` 的 standalone server 需要；默认 `node` 在 PATH，
  可用 `STAYOPS_NODE` 覆盖）
- 前端桌面构建产物：`frontend/.next-desktop/standalone/`（`pnpm --dir desktop build:frontend`）

D1 **不**打包 PostgreSQL、不做一键安装、不装 Windows Service、不改 SQLite。

## 5. 构建

```bash
# 1) 前端 standalone 生产构建（隔离 .next-desktop，注入 BACKEND_API_URL=8100）
pnpm --dir desktop build:frontend

# 2) 桌面主进程编译 + 打包（win-unpacked → desktop/dist/win-unpacked/StayOps.exe）
pnpm --dir desktop dist

# 3) （可选，D1 未交付）Portable 单文件
pnpm --dir desktop dist:portable
```

打包产物：

- `desktop/dist/win-unpacked/StayOps.exe`（正式输出，electron-builder `afterPack`
  钩子自动安装前端资源）

前端 standalone 由 `scripts/install-standalone.mjs` 装入
`resources/frontend-server/`（不进 asar）：除 `server.js/.next-desktop/public`
外，`node_modules` 以 **junction 指向工作区 `frontend/node_modules`**——Next 16
trace 保留 pnpm 兄弟依赖布局（next 的运行时依赖如 `@swc/helpers` 完整版本在
`.pnpm/<pkg>/node_modules/` 内），flatten 成真实目录会破坏解析（曾实测
`Cannot find module '@swc/helpers/_/_interop_require_default'`）。D1 本就依赖
本机工作区（backend/.venv 同理由），打包版前端因此也要求工作区存在。

开发运行（不打包，直接起桌面壳）：

```bash
pnpm --dir desktop start
```

## 6. 日志

位置：`%LOCALAPPDATA%\StayOps\logs\`

- `desktop.log` — 主进程启动状态机/停机记录
- `backend.log` — uvicorn 输出（access log + 应用日志）
- `frontend.log` — Next standalone 输出

全部日志先经 scrub 再落盘：`DATABASE_URL` 密码、`sk-*` DeepSeek Key、
`AI_ENCRYPTION_KEY`、`Authorization: Bearer`、`api_key=` 一律掩码。
日志不污染 Git workspace。

## 7. 进程所有权与停机

- 只记录并管理自己启动的 Backend / Frontend PID（`supervisor.ownedPids()`）。
- 停止顺序：先前端（`taskkill /PID <own> /T` 优雅尝试 → 超时 → `/T /F`），
  再后端（关闭 stdin → uvicorn 优雅停机 `should_exit` → 超时 → `/T /F`）。
- 绝不 `taskkill` 所有 node/python，绝不 kill 未知端口所有者。
- 关闭主窗口 / 托盘退出 = 完整退出：子进程优雅停止 → 端口释放 → Electron 退出。
- 全程 `windowsHide: true` + `detached`，正常使用周期内 PowerShell/CMD 弹窗 = 0。

## 8. Electron 安全

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- Renderer 无 fs / child_process / 任意 shell / process.env。
- Preload 只暴露白名单 IPC：`getState / onEvent / retry / migrationUpgrade /
  openLogs / quit`（见 `desktop/src/runtime/ipc.ts`）。
- 主窗口 `will-navigate` 拦截非应用源跳转；`setWindowOpenHandler` 只允许
  https/http 用系统浏览器打开。
- 秘密（DATABASE_URL / AI_ENCRYPTION_KEY / DeepSeek Key）永不进入 renderer、
  bundle、localStorage、启动窗口 HTML 或日志。

## 9. 目录结构

```
desktop/
  package.json / tsconfig.json / vitest.config.mts / electron-builder.yml
  scripts/
    build-frontend.mjs      # Next standalone 构建 + 装配（static/public）
    make-brand-icons.cjs   # 品牌图标生成（Electron nativeImage 缩放，母版 assets/icon-master.png）
  src/
    main.ts                 # Electron 主进程编排（单实例/窗口/托盘/IPC/停机）
    preload.ts              # 白名单 Bridge 接线
    startup/                # 启动窗口（原生 HTML/CSS/JS，无框架）
    runtime/
      config.ts             # 端口/路径解析（纯函数）
      scrub.ts              # 日志秘密清洗（纯函数）
      migration.ts          # alembic 输出解析/分类（纯函数）
      preflight.ts          # 端口/运行时只读探测
      probe.ts              # Python 探针（desktop_runtime.py）JSON 调用
      processes.ts          # 进程所有权与优雅停机
      startup.ts            # 启动状态机
      logger.ts             # %LOCALAPPDATA% 日志（scrub 流）
      ipc.ts / bridge.ts    # IPC 白名单常量 / Bridge 工厂
    runtime/__tests__/      # Vitest 单元测试（59 用例）
backend/scripts/
  desktop_backend_runner.py # uvicorn in-process + stdin 优雅停机桥
scripts/
  desktop_runtime.py        # 桌面探针 CLI（db-ensure / db-check /
                            #   migration-status / migration-upgrade /
                            #   ports-check，JSON 输出）
  desktop_db_backup.py      # 自带 PostgreSQL 备份/恢复（pg_dump -Fc + SHA-256）
```

## 10. 测试

```bash
pnpm --dir desktop test        # Vitest 62 用例（v1.0.0-alpha.9.3 实测）：端口预检/路径解析/
                               #   迁移解析/scrub/进程所有权/优雅停机/单实例/
                               #   IPC 白名单/db-ensure 启动阶段与 PG 路径
pnpm --dir desktop typecheck   # tsc --noEmit（含测试文件）
pnpm --dir desktop dist        # Fresh Build -> dist/win-unpacked/StayOps.exe
node desktop/scripts/verify_icons.cjs   # 打包产物品牌校验（asar 清单 / 字节一致 /
                                        #   exe 内嵌图标探针），失败退出非 0
```

## 11. D1 已知限制

- 依赖 StayOps 工作区（backend/.venv + frontend/node_modules + Node.js）；
  PostgreSQL 由 StayOps 自带 Runtime 提供（见 §12），不再依赖 Docker/系统安装。
- 前端生产构建需在打包前执行 `build:frontend`（未自动触发）。
- 打包未签名（无 code signing），Windows SmartScreen 可能提示。
- D1 不做：NSIS Setup.exe、自动更新、托盘常驻后台（主窗口关闭即退出）。
- 工作区路径默认 `D:\MY SELF\StayOps V1.0`，可用 `STAYOPS_ROOT` 覆盖。
- **Portable 目标 D1 未交付**：Next standalone 的 node_modules 为指向工作区
  `frontend/node_modules` 的 junction（pnpm 兄弟依赖解析所必需），
  electron-builder portable 的 7z 会跟随 junction 把整个依赖树压入
  （实测中间产物 >950MB 且超时）；需先实现「standalone 完全自包含」的
  node_modules 布局（D1 范围外，已记录 docs/DECISIONS.md）。正式输出为
  `dist/win-unpacked/StayOps.exe`。
- AI 长查询（如「近七天运营情况」）：Desktop D1 compatibility fix 已为
  POST /ai-manager/chat 设置独立 BFF 超时 90s（`AI_CHAT_TIMEOUT_MS`，
  依据 S9 provider 超时 60s + 余量；实测真实响应 15.7s 正常通过），
  其余 BFF 请求保持 15s 不变；详见 docs/DECISIONS.md。

## 12. 自带 PostgreSQL Runtime（独立运行）

StayOps Desktop 自带并自主管理 PostgreSQL 16 实例，双击 StayOps.exe
即可运行，不依赖 Docker Desktop / 系统 PostgreSQL / 开发工具。

> **范围说明（避免误读）**：本能力解除的是**数据库依赖**，不是 workspace 依赖。
> Desktop 仍运行于 StayOps 工作区 runtime layout（`backend/.venv`、
> `frontend/node_modules`、Node.js、`runtime/postgres` 二进制），尚未实现完整
> runtime bundling 与安装器。因此它不是「完全独立安装版」，也不是 Desktop D2；
> 当前准确表述是：**StayOps Desktop 在当前开发机 runtime layout 上自管理其
> PostgreSQL 实例**。

- 二进制：`runtime/postgres/pgsql/`（EDB Windows binaries 解压，gitignored，
  随 runtime 分发；缺失时启动窗口明确报错）。
- 数据目录：`%PROGRAMDATA%\StayOps\PostgreSQL\data`（与程序目录彻底分离，
  升级永不触碰业务数据）。
- 凭据：`%PROGRAMDATA%\StayOps\PostgreSQL\conf\dbpass.conf`（首次 initdb
  自动生成 scram 密码，icacls 收紧 ACL）。
- 网络：仅监听 `127.0.0.1:5433`（与开发 Docker 5432 并存，不暴露局域网）。
- 启动链：`StayOps.exe → db-ensure 探针（init/start/ready/建库）→
  alembic 检查 → backend(注入 DATABASE_URL) → frontend → 主窗口`。
- 生命周期：pg_ctl 独立进程，StayOps 退出后 PostgreSQL 保持运行
  （可靠性优先：秒级重开 + WAL 崩溃恢复）。
- 备份/恢复：`python scripts/desktop_db_backup.py`（备份到
  `%PROGRAMDATA%\StayOps\backups\`；`--restore <dump> --yes` 恢复）。
- 首次全新安装流程：initdb 自动完成 → 启动窗口提示数据库升级 → 用户确认
  alembic upgrade head → 进入应用（与既有迁移 UX 一致）。

## 13. Packaged Mode / 安装版（v1.0.0-alpha.9.4 · D2 foundation）

安装版把**全部运行时**放进安装目录，用户机器上不需要任何预装组件
（Python / Node.js / pnpm / PostgreSQL / Docker / Git 一律不需要）。

### 13.1 两种运行模式

| | Development Mode（未打包） | Packaged Mode（安装版） |
|---|---|---|
| 解析根 | StayOps 工作区（`D:\MY SELF\StayOps V1.0`） | `process.resourcesPath` |
| Python | `backend/.venv/Scripts/python.exe` | `resources/python/python.exe` |
| PostgreSQL | `<workspace>/runtime/postgres/pgsql` | `resources/postgres/pgsql` |
| Node | PATH（或 `STAYOPS_NODE`） | `resources/node/node.exe` |
| 前端 | `<workspace>/frontend/.next-desktop/standalone` | `resources/frontend-server` |
| 探测脚本 | `<workspace>/scripts/*.py` | `resources/scripts/*.py` |
| 前置条件 | 工作区 + `.venv` | **无**（结构自识别，不需要 `AGENTS.md`/`.venv`/`STAYOPS_ROOT`） |

`config.ts` 的 `buildPaths()` 按 `isPackaged` 分支；`isValidWorkspaceRoot()` 同时
识别「开发工作区」与「packaged runtime 布局」（`backend/app/main.py` +
`python/python.exe`）。源码中**不再包含任何硬编码开发机路径**（安全审计要求）。

### 13.2 安装目录布局（electron-builder extraResources）

```
<install>/resources/
  app.asar              Electron 主进程 + 启动窗口资源（品牌图标）
  backend/              FastAPI app + alembic + desktop_backend_runner.py
  python/               Python 3.11 运行时 + 后端依赖（site-packages）
  node/                 node.exe（Next standalone server 运行时）
  postgres/pgsql/       PostgreSQL 16（bin/lib/share）
  scripts/              desktop_runtime.py / dev_runtime.py / desktop_db_backup.py
  frontend-server/      Next standalone（依赖已全部物化为真实文件）
```

构建：`pnpm.cmd dist:installer` = `make-brand-icons` → `bundle-runtimes.mjs`
（装配 `desktop/.bundle/` + 安全扫描）→ `next build` → `electron-builder --win nsis`。

### 13.3 前端自包含（junction → 真实文件）

D1 的 `resources/frontend-server/node_modules` 是指向开发机
`frontend/node_modules` 的 junction，换机器必然失效。D2 由
`install-standalone.mjs` 递归物化：每个 junction 复制为真实文件（pnpm 兄弟
依赖环用「祖先真实路径」集合防环），排除 `*.map`，并把 Next 内嵌的构建机
绝对路径（`outputFileTracingRoot` / `repoRoot` / `turbopack.root` / `appDir`）
改写为中立值；结束后断言树内 reparse point 为 0。

### 13.4 首次安装引导（随机管理员密码）

干净机器上没有可登录账号，因此启动链在迁移阶段执行幂等 `seed-ensure`：

1. 权限 52 / 角色 6 / 房型 / 房间（28）等基础数据；
2. 若 `admin` 尚不存在 → 生成**随机高强度密码**（`secrets.token_urlsafe(24)`），
   以 **DPAPI（当前用户作用域）** 密文存于
   `%PROGRAMDATA%\StayOps\config\admin-bootstrap.dat`（绝不存明文）；
3. 密码**只注入 seed 进程**（`STAYOPS_ADMIN_PASSWORD`，用后即清除），
   并且**只在首次启动 UI 显示一次**；`desktop.log` 中的该事件密码字段固定为 `***`；
4. 该管理员带 `must_change_password=true`：改密前后端拒绝除
   `/auth/me`、`/auth/change-password` 之外的接口（前端 `/change-password` 引导）；
5. 改密成功后清除标记；下次启动检测到 bootstrap 凭据已不匹配当前哈希 →
   **销毁**该凭据（不再保留任何引导凭据）。

### 13.5 安装级 AI 加密密钥

`AI_ENCRYPTION_KEY` 不再允许回退到公开的开发默认值：首次启动生成每台安装
独立的随机 32 字节 Fernet 密钥，DPAPI 保护存放于
`%PROGRAMDATA%\StayOps\config\ai_encryption.key`，仅注入后端进程环境变量；
packaged 模式下不可用即 **Fail Safe**（不启动），绝不静默使用不安全默认值。

### 13.6 数据生命周期

| 类别 | 位置 | 升级 / 重装 | 卸载 |
|---|---|---|---|
| 程序 | 安装目录（per-user） | 覆盖 | 删除 |
| 数据库 | `%PROGRAMDATA%\StayOps\PostgreSQL\data` | **保留** | **保留** |
| 配置/密钥 | `%PROGRAMDATA%\StayOps\config` | **保留** | **保留** |
| 日志 | `%LOCALAPPDATA%\StayOps\logs` | 保留 | 保留 |

安装包默认 `perMachine: false`（per-user，不需要管理员日常运行）、
`deleteAppDataOnUninstall: false`（卸载不删业务库）。

### 13.7 已知技术债（本轮实测修复）

- `_tighten_acl` 曾用账号名授权，被 icacls 解析为「域 + 空账号名」，生成无效
  ACE，配合 `/inheritance:r` 会把当前用户锁在 `%PROGRAMDATA%\StayOps\config`
  之外（alpha.9.3 遗留实测；已改为 **SID 授权 + 读/写回校验 + 自愈修复**）。
- `seed()` 的 stdout 会污染探针 JSON（成功被误判为失败）→ 已截获丢弃。
