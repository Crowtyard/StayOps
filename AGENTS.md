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
