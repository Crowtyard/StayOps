# 环境检查报告

- 检查时间：2026-08-25 17:39（UTC+8）
- 检查方式：真实执行版本命令检测，未做任何推断或编造

## 一、工具链版本

| 工具 | 版本 | 检测命令 | 备注 |
| --- | --- | --- | --- |
| Node.js | v24.18.0 | `node --version` | PATH 中 Node 与 DSH 捆绑运行时（`Runtime\node\node.exe`）同为 v24.18.0 |
| npm | 11.16.0 | `cmd /c "npm --version"` | `npm.ps1` 被 PowerShell 执行策略阻止，需经 `npm.cmd` 调用（见已知问题 1） |
| pnpm | 10.34.5 | `cmd /c "pnpm --version"` | 同上，需经 `pnpm.cmd` 调用 |
| Git | 2.55.0.windows.3 | `git --version` | 正常 |
| Python | 3.11.9 / 3.12.10 | `python --version`、`py -0p` | 已装双版本：`python` 解析到 3.11.9，`py` 启动器默认 3.12.10（见已知问题 4） |
| Docker | 客户端 29.7.2（Docker Desktop 4.88.0） | `docker --version`（安装目录完整路径） | Docker Desktop 已安装并启动，但 WSL2 未安装导致引擎无法启动（见已知问题 2） |
| DSH（DeepSeek Harness） | 0.1.1-rc.2 | 读取 `Harness\package.json` 与 `node_modules\@deepseek-ai\dsh\package.json` | 无全局 `dsh` CLI（不在 PATH）；`DSH_SHELL=1`，`DSH_HOME=D:\MY SELF\DeepSeek Harness\Data` |

## 二、环境检查结论

### 1. 插件安装情况

- **核心插件框架**：cordis 4.0.1、cosmokit 1.8.2、schemastery 3.18.1。
- **官方插件**：`@deepseek-ai/dsh` 及全部官方插件（dsh-agent、dsh-tool-*、dsh-client-ui-*、dsh-session-* 等约 200 个）统一为 **0.1.1-rc.2**，安装完整。
- **headless profile**（`Data\profiles\headless`）：bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`，cordis 树为空（无自定义 patch）。
- **web profile**（`Data\profiles\web`）：bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，并安装以下社区插件（版本经 node_modules 实测确认）：

  | 插件 | 版本 | 用途 |
  | --- | --- | --- |
  | dshmarket | 1.29.2 | 插件市场 |
  | dsh-skin-market | 0.1.9 | 皮肤市场 |
  | dsh-better-sidebar | 0.16.1 | 侧边栏增强 |
  | @anionex/dsh-turn-rewind | 0.1.2 | 轮次回退 |
  | dsh-context | 0.32.0 | 上下文管理 |
  | dsh-permission-rules | 0.5.5 | 权限规则 |

### 2. 模型配置

- 来源：`Data\settings.yaml`（关键项如下，凭据值不记录）。

  ```yaml
  agent-default-model:
    provider: deepseek-official
    model: deepseek-v4-pro
    reasoningEffort: max
  agent-presets:
    default: standard
  permission:
    defaultPreset: danger-full-access
  ```

- 凭据：`.credentials.yaml` 中已配置 `DEEPSEEK_API_KEY`（存在 `refs.DEEPSEEK_API_KEY` 键，值不外泄、不写入本文件）。
- 本会话 DSH 环境：文件策略 `danger-full-access`，审批提示已禁用。

### 3. 本仓库（StayOps）状态

- 顶层结构齐全：`backend/`、`frontend/`、`infra/`、`tests/`、`docs/`、`.env.example`、`docker-compose.yml`、`README.md`、`AGENTS.md`。
- `backend/frontend/tests/infra` 四个子目录**均无 package.json，node_modules 未安装**（符合 Sprint 1 前骨架状态）。
- `docker-compose.yml` 当前仅定义 PostgreSQL 16-alpine（backend/frontend 服务仍为注释）。

## 三、已知问题

1. **PowerShell 执行策略阻止 npm/pnpm 的 .ps1 启动器**：全部作用域（MachinePolicy/UserPolicy/Process/CurrentUser/LocalMachine）均为 Undefined（Windows 下有效策略为 Restricted），`npm`、`pnpm` 直接调用会报 `SecurityError`。绕过方式：在 pwsh 中改用 `npm.cmd` / `pnpm.cmd`，或将 CurrentUser 策略设为 `RemoteSigned`。
2. **Docker 引擎无法启动（WSL2 未安装）**：Docker Desktop 4.88.0 已通过 winget 官方源安装并启动，`docker` 客户端 29.7.2 可用（`C:\Program Files\Docker\Docker\resources\bin\docker.exe`），但 **WSL2 未安装**（`wsl --status` 提示未安装），Docker 引擎无法初始化（API 返回 500）。解决步骤：以管理员运行 `wsl --install` → 重启系统 → 打开 Docker Desktop → `docker run --rm hello-world` 验证。在此之前 `docker compose up -d postgres` 不可用。Docker 客户端不在 PATH 是安装后 PATH 未刷新的正常现象，重开终端即可。
3. **无全局 dsh CLI**：`dsh` 命令不在 PATH，DSH 通过 Harness 桌面应用运行；`dsh --version` 无法执行。
4. **Python 双版本共存**：`python`（PATH 第一个）为 3.11.9，`py` 启动器默认为 3.12.10。创建 venv 或运行脚本时需显式指定版本，避免 3.11/3.12 混用。
5. **部分 DSH 插件 package.json 为非 UTF-8 编码**：如 `dshmarket` 的 package.json 为 GBK/ANSI 编码，PowerShell `ConvertFrom-Json` 解析报错（`Invalid object passed in`）。脚本读取这些文件时需指定编码（如 `Get-Content -Encoding Default`），不影响插件实际运行。
6. **依赖尚未安装**：仓库四个工程目录均无 package.json 与 node_modules，后续 Sprint 初始化工程后需执行 `pnpm install`（用 `pnpm.cmd`）。
