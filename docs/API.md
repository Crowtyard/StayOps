# StayOps API

> Sprint 1 第二阶段已实现。统一前缀 `/api/v1`，JSON 请求/响应，JWT（Bearer）认证。

## 约定

- **认证**：`Authorization: Bearer <access_token>`（登录接口返回）；未认证 401，权限不足 403，资源不存在 404，唯一键冲突/非法状态转换 409，参数校验失败 422
- **错误格式**：FastAPI 默认 `{"detail": "..."}`
- **分页**：列表接口统一 `?page=1&page_size=20`（page_size 上限 100），返回 `{"items": [...], "total": n, "page": 1, "page_size": 20}`
- **审计**：所有写操作（含登录成功/失败）写 `audit_logs`，含操作人、action、资源、details 摘要与 IP（优先 `X-Forwarded-For` 首段）；details 不含密码/Token
- **金额**：`base_price` 为 Decimal，JSON 序列化为字符串（如 `"328.00"`，避免浮点精度问题），提交时接受数字或字符串
- **密码**：仅存 bcrypt 哈希；任何响应/日志不返回密码与哈希
- 开发管理员：`admin` / `Admin@123456`（仅开发环境）

## 端点一览

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | /auth/login | 登录，返回 access_token | 公开 |
| GET | /auth/me | 当前用户 + 角色 + 权限 code 列表 | 登录 |
| GET | /users | 用户列表（分页） | user:read |
| POST | /users | 创建用户 | user:write |
| GET | /users/{id} | 用户详情 | user:read |
| PUT | /users/{id} | 更新用户（可改密码/启用禁用；不可禁用自己） | user:write |
| DELETE | /users/{id} | 删除用户（不可删除自己） | user:delete |
| POST | /users/{id}/roles | 分配角色（整体替换，空=清空） | user:write |
| GET | /roles | 角色列表（分页） | role:read |
| POST | /roles | 创建角色 | role:write |
| GET | /roles/{id} | 角色详情 | role:read |
| PUT | /roles/{id} | 更新角色 | role:write |
| DELETE | /roles/{id} | 删除角色（级联清理关联） | role:delete |
| POST | /roles/{id}/permissions | 设置角色权限（整体替换，空=清空） | role:write |
| GET | /permissions | 权限列表（分页，17 个） | role:read |
| GET | /room-types | 房型列表（分页，含 room_count） | room_type:read |
| POST | /room-types | 创建房型 | room_type:write |
| GET | /room-types/{id} | 房型详情 | room_type:read |
| PUT | /room-types/{id} | 更新房型 | room_type:write |
| DELETE | /room-types/{id} | 删除房型（有房间时 409） | room_type:delete |
| GET | /rooms | 房间列表（分页，`?occupancy_status=` / `?cleaning_status=` / `?room_type_id=` 筛选） | room:read |
| POST | /rooms | 创建房间（occupancy_status 默认 available，cleaning_status 默认 clean） | room:write |
| GET | /rooms/{id} | 房间详情 | room:read |
| PUT | /rooms/{id} | 更新房间基础信息（不含状态） | room:write |
| DELETE | /rooms/{id} | 删除房间 | room:delete |
| POST | /rooms/{id}/status | 房态变更（状态机校验，非法 409；写审计） | room:write 或 room:status_cleaning / room:status_maintenance（对应目标房态） |
| GET | /audit-logs | 审计日志列表（分页，`?action=` / `?user_id=` / `?resource_type=` 筛选） | audit:read |

## 认证与权限

- JWT HS256，`sub`=用户 id，有效期 12 小时（`access_token_expire_minutes`）
- 权限解析链：users → user_roles → roles → role_permissions → permissions（按 code 校验）
- 角色权限映射见种子（`backend/app/seed.py`）；SUPER_ADMIN 动态拥有全部权限
- 账号禁用后旧 Token 立即失效（403）

## 房态状态机（双维度）

`rooms.occupancy_status` / `rooms.cleaning_status` 相互独立，仅通过 `POST /rooms/{id}/status` 变更（body 至少提供一个维度；PUT 不接收状态字段）。非法转换 409。

| 维度 | 当前状态 | 允许转换到 |
|---|---|---|
| 占用 | available | reserved / occupied / blocked / out_of_service |
| 占用 | reserved | available / occupied / blocked / out_of_service |
| 占用 | occupied | available / reserved / out_of_service |
| 占用 | blocked | available / out_of_service |
| 占用 | out_of_service | available / blocked |
| 清洁 | clean | dirty |
| 清洁 | dirty | cleaning |
| 清洁 | cleaning | clean / inspection / rework |
| 清洁 | inspection | clean / rework |
| 清洁 | rework | cleaning |

同一状态转换视为非法（409）；两维度互不约束（如 reserved+dirty 合法）。鉴权：`room:write` 可改任意维度；`room:status_cleaning` 仅清洁维度；`room:status_maintenance` 仅把占用置为 out_of_service；无 `room:write` 不允许同时改两维度（403）。

## 前端 BFF 端点（Next.js Route Handler，T3a）

浏览器不接触 JWT；前端统一经以下端点（同源 `http://localhost:3000`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/login | 转发后端登录，成功写 HttpOnly Cookie `stayops_token`，返回用户+角色+权限（同 `MeOut`） |
| GET | /api/auth/me | 读 Cookie 调后端 /auth/me；401 时清 Cookie |
| POST | /api/auth/logout | 清 Cookie |
| * | /api/bff/{...path} | 通用代理 → `BACKEND_API_URL/api/v1/{...path}`：附加 Bearer、透传查询串/请求体/状态码/`detail`、转发 X-Forwarded-For；后端不可达 502 |

## 示例

```powershell
# 登录（直连后端）
curl.exe -X POST http://localhost:8000/api/v1/auth/login `
  -H "Content-Type: application/json" `
  -d '{"username":"admin","password":"Admin@123456"}'

# 带 Token 查询房间（第一页 20 条）
curl.exe "http://localhost:8000/api/v1/rooms?page=1&page_size=20" `
  -H "Authorization: Bearer <access_token>"

# 变更房态（经前端 BFF，Cookie 认证）
curl.exe -c cookies.txt -X POST http://localhost:3000/api/auth/login `
  -H "Content-Type: application/json" `
  -d '{"username":"admin","password":"Admin@123456"}'
curl.exe -b cookies.txt -X POST http://localhost:3000/api/bff/rooms/1/status `
  -H "Content-Type: application/json" `
  -d '{"occupancy_status":"occupied"}'
```
