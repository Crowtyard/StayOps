# StayOps AI Manager（DeepSeek AI 店长）

> Sprint 9 · DeepSeek AI Manager · Alpha.9 范围：真正可用、简单、安全的
> AI 数据分析入口（**不是**复杂 Agent 平台）。

## 1. 架构

```text
/ai-manager（前端 Chat UI）
     ↓
StayOps Backend（/api/v1/ai-manager、/api/v1/settings/ai）
     ↓
DeepSeek API（集中 DeepSeekClient）
   ↙          ↘
S8 Analytics    Read-only SQL（Validator + stayops_ai_reader 双层保护）
                  ↓
              PostgreSQL
```

DeepSeek 可以：阅读数据 / 查询数据 / 聚合数据 / 分析数据 / 解释数据 / 给出建议。
DeepSeek 不可以：修改 / 创建 / 删除业务数据、执行运营动作。

## 2. 三条安全规则（LOCKED）

1. **AI database access = READ ONLY**
2. **DeepSeek API Key = Backend only**（加密存储，任何响应/日志/审计不返回完整 Key）
3. **AI has NO write tools**（只有 `get_analytics` 与 `query_stayops_database` 两个只读工具）

即使用户 Prompt 要求删除订单 / 修改房态 / 停售房间 / 审批采购 / 修改库存，
AI 也没有对应能力（应用 Validator + 数据库只读 Role 双重拒绝）。

## 3. DeepSeek 配置（/settings/ai）

- 权限：`ai_manager:manage`（SUPER_ADMIN / MANAGER）
- Provider：DeepSeek（Alpha.9 唯一 Provider，不建立 Multi-provider Framework）
- 保存 API Key（Fernet 加密落库 `ai_settings.api_key_encrypted`）
- 更新 API Key / 删除 API Key / Test Connection
- API 约定：`GET/PUT /settings/ai`、`DELETE /settings/ai/key`、
  `POST /settings/ai/test`（可携带 `api_key` 只测不存）
- 未知模型由 Test Connection 暴露 Provider 错误（§27）

## 4. API Key 安全

- 禁止：localStorage / sessionStorage / frontend env bundle / Git / plaintext
  API response
- 前端只能看到 `configured: true` 或 `key_masked: sk-****abcd`
- Backend 不提供「读取完整 API Key」的接口
- 加密：成熟加密库 **cryptography（Fernet）**（随 python-jose[cryptography]
  已安装，无新增依赖；禁止自创加密算法）
- 加密密钥来自 Backend environment/config
  （`AI_ENCRYPTION_KEY` → `settings.ai_api_key_encryption_key`），
  与密文分开存储；生产必须显式配置
- 密钥不匹配/密文损坏 → 按未配置处理（不崩溃）

## 5. 只读 SQL（query_stayops_database）

输入：单条 `SELECT` / `WITH ... SELECT`；输出：`{columns, rows, row_count, truncated}`。

双层保护：

1. **应用层 Validator**（`app/core/ai_sql_validator.py`）：完整词法扫描
   （字符串 / 注释 / dollar-quote 正确跳过，非脆弱 substring）：
   - 只允许 SELECT / WITH ... SELECT（WITH 必须含顶层 SELECT 主查询）
   - 拒绝：INSERT / UPDATE / DELETE / MERGE / TRUNCATE / CREATE / ALTER /
     DROP / GRANT / REVOKE / COPY / CALL / DO / SET / INTO / EXECUTE /
     PREPARE / DEALLOCATE / VACUUM / REINDEX / CLUSTER / REFRESH / COMMENT /
     SECURITY / LOCK / LISTEN / NOTIFY / UNLISTEN / DISCARD / RESET / SHOW /
     DECLARE / MOVE / CLOSE / IMPORT / ANALYZE（数据修改型 CTE 同样拒绝）
   - 拒绝多语句（单次只能一个 Query；允许单个结尾分号）
   - 表白名单（SQL Domain Access）+ 敏感字段标识符拒绝
2. **数据库层**（`stayops_ai_reader` 只读 Role）：
   - 独立连接账号，仅 `CONNECT` + `USAGE schema public` +
     `SELECT` 21 个 `ai_*` 视图（无任何基表权限）
   - 即使绕过 Validator：INSERT/UPDATE/DELETE/TRUNCATE/CREATE/ALTER/DROP
     被 PostgreSQL 拒绝（permission denied / must be owner）
   - `SET TRANSACTION READ ONLY` + `statement_timeout` 再兜底

限制（§15）：默认最多返回 **200 行**（硬上限 500）、查询超时可控
（`AI_SQL_STATEMENT_TIMEOUT_MS`，默认 10000ms）、JSON 安全序列化
（Decimal/date → 字符串）。

## 6. SQL Domain Access（当前用户权限继承，§22-§24）

| 权限域 | 可查询视图 |
|---|---|
| `analytics:operations_read` | ai_room_types / ai_rooms / ai_reservations（无金额与 Guest 关联）/ ai_stays / ai_stay_room_assignments / ai_housekeeping_tasks / ai_maintenance_work_orders / ai_users（有限字段） |
| `analytics:business_read` | ai_inventory_items / ai_inventory_locations / ai_inventory_balances / ai_stock_movements / ai_stock_issues / ai_stock_issue_lines / ai_suppliers（无联系方式）/ ai_purchase_requests / ai_purchase_request_lines / ai_purchase_orders / ai_purchase_order_lines / ai_goods_receipts / ai_goods_receipt_lines |

原则：**AI visible data = current user's permissions**。
`ai_manager:use` 只是「可以打开 AI Manager」，不是「可以读取整个数据库」。

## 7. get_analytics（S8 Analytics Tool）

- 端点白名单：operations（overview / bookings / housekeeping / maintenance /
  room-moves / forecast）+ business（rooms / inventory / procurement）
- 权限继承：operations 端点要求 `analytics:operations_read`，business 端点
  要求 `analytics:business_read`，否则返回 `AI_PERMISSION_DENIED`
- 指标定义唯一权威 = S8 Analytics Service（禁止 AI 自行重新实现
  Physical Occupancy / ADR / RevPAR / Cancellation / No-show / ALOS / Forecast）
- 区间校验与 /analytics 路由同规则（from<to、to<=业务日期、跨度<=366）

## 8. RBAC

| 权限 | SUPER_ADMIN | MANAGER | FRONT_DESK | HOUSEKEEPING | MAINTENANCE | FINANCE |
|---|---|---|---|---|---|---|
| `ai_manager:use` | ✓ | ✓ | ✓ | × | × | ✓ |
| `ai_manager:manage` | ✓ | ✓ | × | × | × | × |

（seed 幂等收敛，共 52 权限码；用 permission 判断，禁止硬编码角色名。）

## 9. Provider 失败隔离（§7）

DeepSeek timeout / 401 / 402 / 429 / 5xx / 网络不可达 / malformed response
只影响 `/ai-manager` 与 `/settings/ai/test`，绝不 500 化：
返回清晰业务错误码（HTTP 409 或 502）：

```text
AI_NOT_CONFIGURED / AI_AUTH_FAILED / AI_RATE_LIMITED /
AI_PROVIDER_UNAVAILABLE / AI_TIMEOUT / AI_RESPONSE_INVALID
```

`/login`、`/dashboard`、`/front-desk`、`/rooms`、`/housekeeping`、
`/maintenance`、`/inventory`、`/procurement`、`/analytics` 全部不受影响
（pytest 隔离测试 + E2E Flow D 锁定）。

## 10. Chat 会话（/ai-manager）

- `POST /api/v1/ai-manager/chat`（`conversation_id?` + `message`）→
  `{conversation_id, answer, model, usage?}`；Alpha.9 不做 Streaming
- `GET /api/v1/ai-manager/conversations/{id}/messages`：历史消息（仅本人）
- 上下文：最近 10 条消息（`AI_CONTEXT_MESSAGES`）；不做 long-term memory /
  vector DB / RAG / summarizer
- 工具循环上限 5 轮（`AI_MAX_TOOL_ROUNDS`），超限返回安全错误
- 持久化：ai_conversations / ai_messages（user/assistant；工具消息与完整
  SQL 结果不持久化）；只保存 user_id / role / content / 时间戳 /
  provider·model / token usage
- Prompt Injection（写 SQL / PII 请求）由 Validator + 视图白名单硬拒绝，
  不依赖模型自己拒绝

## 11. 已知限制（Known Limitations）

- Alpha.9 仅 DeepSeek（不建立多 Provider 框架）；不做 Streaming
- 不做：自动房态/维修/采购/库存动作、autonomous agent、scheduled AI
  decisions、voice、vector DB / RAG、长期记忆、AI anomaly ML、
  demand prediction、revenue optimization
- `ai_reservations` 视图不含金额（Contracted Value 只能经
  `get_analytics` business 端点获取）
- 无在线模型列表同步；未知模型由 Test Connection 暴露 Provider 错误
- 会话历史仅按本人可见；无跨用户共享/导出
- AI 回答为普通 Markdown/Text，无复杂 Evidence JSON Schema
- `stayops_ai_reader` 角色为集群级对象：迁移 downgrade 不 DROP ROLE
  （只撤销授权），避免影响其它数据库
- 测试使用 FakeDeepSeekClient / 本地 Fake Provider（确定性）；真实
  DeepSeek 冒烟仅在配置真实 Key 时手动进行

## 12. 测试

- 后端 pytest：Validator（写语句全拒 / 合法查询不误判）、Executor（行数 /
  超时 / DB 只读 Role 拒绝写）、Tools（Analytics 域继承 / SQL Domain Access）、
  Chat（Fake Provider 工具循环 / 错误映射 / 上下文窗口 / 注入拒绝 / 归属）、
  Settings API（掩码 / 密文 / RBAC / Test）、加密、迁移往返与数据保留、
  Provider 隔离
- Vitest：AI 错误文案 / 快捷问题 / Markdown 安全渲染 / Chat 视图 /
  Settings 视图 / 导航矩阵
- Playwright（Fake Provider，绝不触碰真实 DeepSeek）：Flow A Settings、
  Flow B Chat、Flow C 权限隔离、Flow D Provider 失败隔离、Flow E SQL 安全
