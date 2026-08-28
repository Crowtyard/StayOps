# StayOps Agent Rules

## 核心工程原则（Sprint 3 起生效，所有 Sprint 默认遵守）

**Principle A · Product Design Is Ours**：外部开源项目只是实现参考，不是产品规格。它们不能决定 StayOps 做什么、页面如何设计，不能擅自改变我们的产品流程。Product Requirement / User Flow / Information Architecture / UI-UX / Scope 以 Sprint 指令与现有项目需求为最高权威。

**Principle B · Reuse Before Build**：写新代码前按顺序判断——① StayOps 已有可复用实现？② Python / FastAPI / PostgreSQL / Next.js / 浏览器原生能力能否解决？③ 已安装依赖能否解决？④ 成熟开源项目有没有经过验证的实现模式？⑤ 都不适合才写最小必要的新代码。禁止为了“架构漂亮”重造已有轮子。

**Principle C · Do Not Reinvent Solved Engineering Problems**：数据库约束、并发安全、事务、状态机、幂等、权限检查、审计、测试隔离、E2E 数据准备等工程问题优先学习成熟实现（只借鉴 HOW TO IMPLEMENT，不得让开源项目改变 WHAT STAYOPS SHOULD DO）。

**Principle D · Safety Beats Less Code**：Reuse First 不等于减少必要安全机制。不得为了少代码牺牲 RBAC、PII 保护、事务安全、数据库完整性、校验、审计、并发保护、错误语义、测试。

1. 开始任何开发任务前先阅读：

   - `docs/PRD.md`
   - `docs/SPRINTS.md`
   - `docs/ARCHITECTURE.md`
   - `docs/DECISIONS.md`

2. 不允许一次性开发完整系统。

3. 严格按照 Sprint 开发。

4. 不得提前开发未来 Sprint。

5. 数据库 Schema 修改必须使用 Migration。

6. 不允许直接修改生产数据库。

7. 业务权限必须在后端验证。

8. 前端隐藏按钮不算权限控制。

9. 状态机必须在后端验证合法转换。

10. 不得在日志中输出密码、Token、身份证号等敏感数据。

11. 不存储明文密码。

12. 不把 `.env`、API Key、数据库密码提交到 Git。

13. 每次完成开发任务必须运行相应测试。

14. 修改跨模块架构前必须先分析影响。

15. 不得为了通过测试而删除失败测试。

16. 不得通过 hardcode 假数据伪造成功结果。

17. 不得声称运行过没有实际运行的测试。

18. 每个任务完成后报告：

    - 修改文件
    - 主要实现
    - 数据库变化
    - API 变化
    - 测试命令
    - 测试结果
    - 已知问题

19. 所有重大架构决策记录到：`docs/DECISIONS.md`

20. README 必须始终保持基本可用。

## Local Runtime Policy（Alpha.5 起生效，仓库级永久规则）

背景：alpha.5 曾发生「新 Frontend + 旧 Backend（无 --reload、旧 route set）+ 数据库版本不一致」组成看似能运行的实际事故（stale backend incident：frontend hot-loaded newer code while non-reload backend stayed stale）。本策略为永久工程规则；任何 Sprint / Bugfix 开始前，Agent 必须先阅读并遵守本策略。

**Rule A · Official Dev Entry**

StayOps 正常本地开发统一使用根目录 `start-dev.cmd`（内部为 `scripts/dev_runtime.py` Runtime Supervisor，不要求 PowerShell）。Coding Agent（编程代理）不得把分别长期启动裸 `uvicorn` / `pnpm dev` 作为默认开发运行方式；临时测试环境除外，但必须在任务结束后清理。

**Rule B · Runtime Preflight**

每一个 Sprint / Bugfix / Runtime debugging / Product smoke 在使用 StayOps 日常开发环境前，都必须遵守仓库 Runtime Preflight：至少检查 ports 8000 / 3000、`BACKEND_API_URL`、`alembic current == head`。不得默默复用未知旧进程（`start-dev.cmd --check` 覆盖全部预检）。

**Rule C · Stale Process**

如果 8000 或 3000 已被占用：Coding Agent 不得假定现有服务是正确版本；必须 identify 并 report，然后通过统一 Runtime Policy 处理（停止旧进程后经 `start-dev.cmd` 重启）。不得静默接管旧 Backend，不得自动杀死未知进程。

**Rule D · Backend Development**

StayOps 日常开发 Backend 必须启用 `--reload`（Supervisor 固定使用 `.venv` 的 `uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload`）。除非当前任务属于正式测试 / production-equivalent 环境，并明确要求不同启动方式。

**Rule E · Database**

日常 Dev DB = `stayops`；E2E DB = `stayops_test`，不得混淆。Dev Runtime 启动要求 `alembic current == head`（默认 CHECK ONLY，`--migrate` 为显式升级）。Agent 不得为了通过检查对正常开发数据库执行 downgrade / reset / recreate，除非用户明确授权。

**Rule F · Runtime Readiness**

不得仅以「process started」判断 Runtime Ready。必须经过仓库 supervisor 的校验：Backend health（`/health`）、OpenAPI core-route validation（Rooms / Reservations / Housekeeping / Maintenance 存在于 `/openapi.json`）、Frontend readiness（`/login`）。

**Rule G · Process Ownership**

Coding Agent 可以为了测试启动临时服务；但 Agent 启动的临时 Backend / Frontend 不得在任务完成后继续作为用户的长期 StayOps 服务。临时运行完成后必须清理自己的 process tree，不得留下 stale uvicorn / stale Next dev。

**Rule H · Future Sessions**

所有未来 Coding Agent 在进入 StayOps 工作区后 MUST read `AGENTS.md` before coding or starting services，并遵守 Local Runtime Policy，不依赖历史聊天上下文。
