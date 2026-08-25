# StayOps 架构

> 状态：待 Sprint 1 启动时填充。本文档描述系统整体架构与模块边界。

## 顶层架构

- `frontend/` — Next.js + TypeScript 前端
- `backend/` — FastAPI + Python 后端
- `infra/docker/` — Docker 部署配置
- `docs/` — 项目文档
- `tests/` — 测试

## 原则

- 前后端分离，通过 REST API 通信
- 业务权限在后端验证（前端隐藏按钮不算权限控制）
- 数据库 Schema 变更一律使用 Migration
- 重大架构决策记录到 `DECISIONS.md`
