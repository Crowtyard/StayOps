# -*- coding: utf-8 -*-
"""E2E Fake DeepSeek Provider（Sprint 9 §33/§43 Flow B/D）。

- 本地 127.0.0.1:8099 的 OpenAI 兼容 Chat Completions 假服务，运行在
  run_test_backend.py 同进程的守护线程中。
- 确定性路由（按最后一条 user 消息内容）：
  * 经营类问题 -> get_analytics tool call（由真实 Backend 执行 S8 Analytics）
  * 运营 SQL 问题 -> query_stayops_database tool call（真实只读执行）
  * 恶意写 SQL / PII -> 返回写/PII SQL tool call（由 Backend 拒绝，Flow E）
  * trigger provider error -> HTTP 500（Flow D）
  * trigger malformed  -> 非法 JSON（AI_RESPONSE_INVALID）
  * 工具结果回传后 -> 最终回答回显工具结果（确定性断言）
- 测试绝不向真实 DeepSeek 发送 fake key（base URL 指向本假服务）。
"""

from __future__ import annotations

import json
import threading
import time
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAKE_PORT = 8099

_CST = timezone(timedelta(hours=8))


def _business_date() -> date:
    return datetime.now(_CST).date()


def _tool_call(name: str, arguments: dict) -> dict:
    return {
        "kind": "tool_call",
        "name": name,
        "arguments": arguments,
    }


def _route(messages: list[dict]) -> dict:
    """确定性路由：返回 {"kind": "final"|"tool_call"|"http_error"|"malformed", ...}"""
    tool_msgs = [m for m in messages if m.get("role") == "tool"]
    if tool_msgs:
        content = tool_msgs[-1].get("content", "") or ""
        snippet = content[:200].replace("\n", " ")
        return {
            "kind": "final",
            "content": f"收到数据：{snippet}（FakeProvider 测试回答）",
        }

    user_msgs = [m for m in messages if m.get("role") == "user"]
    text = user_msgs[-1].get("content", "") if user_msgs else ""
    today = _business_date()
    past = today - timedelta(days=30)

    if "trigger provider error" in text:
        return {"kind": "http_error", "status": 500, "body": {"error": "fake boom"}}
    if "trigger malformed" in text:
        return {"kind": "malformed"}

    # 恶意写 SQL（Prompt Injection / Flow E）：Backend 必须拒绝
    if "DROP TABLE" in text or "删除所有" in text:
        return _tool_call("query_stayops_database", {"sql": "DROP TABLE rooms"})
    if "忽略" in text or "ignore previous" in text.lower():
        return _tool_call(
            "query_stayops_database", {"sql": "DELETE FROM ai_rooms"}
        )
    # PII 请求（Flow 安全）：Backend 必须拒绝（guests 表不可访问）
    if "手机号" in text:
        return _tool_call(
            "query_stayops_database", {"sql": "SELECT phone FROM guests"}
        )
    # 运营 SQL 问题（Flow B）
    if "矿泉水" in text:
        return _tool_call(
            "query_stayops_database",
            {
                "sql": "SELECT item_code, name, base_unit FROM ai_inventory_items "
                "WHERE name LIKE '%矿泉水%' ORDER BY id"
            },
        )
    # 经营域（Flow C：FRONT_DESK 应被拒绝）
    if "合同房费" in text or "ADR" in text:
        return _tool_call(
            "get_analytics",
            {"endpoint": "rooms", "from": past.isoformat(), "to": today.isoformat()},
        )
    if "库存风险" in text:
        return _tool_call(
            "get_analytics",
            {
                "endpoint": "inventory",
                "from": past.isoformat(),
                "to": today.isoformat(),
            },
        )
    if "采购情况" in text:
        return _tool_call(
            "get_analytics",
            {
                "endpoint": "procurement",
                "from": past.isoformat(),
                "to": today.isoformat(),
            },
        )
    # 运营域（Flow B / Flow C：FINANCE 应被拒绝）
    if any(k in text for k in ("入住率", "经营情况", "维修最多", "换房次数", "未来7天")):
        return _tool_call(
            "get_analytics",
            {
                "endpoint": "overview",
                "from": past.isoformat(),
                "to": today.isoformat(),
            },
        )
    return {"kind": "final", "content": "OK（FakeProvider 测试回答）"}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静默访问日志
        pass

    def _respond_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._respond_json(200, {"status": "ok"})
            return
        self._respond_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/chat/completions":
            self._respond_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._respond_json(400, {"error": "bad json"})
            return
        messages = payload.get("messages") or []
        step = _route(messages)

        if step["kind"] == "http_error":
            self._respond_json(step["status"], step["body"])
            return
        if step["kind"] == "malformed":
            body = b"{not-json!!"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if step["kind"] == "tool_call":
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_fake_1",
                        "type": "function",
                        "function": {
                            "name": step["name"],
                            "arguments": json.dumps(step["arguments"]),
                        },
                    }
                ],
            }
            finish = "tool_calls"
        else:
            message = {"role": "assistant", "content": step["content"]}
            finish = "stop"

        self._respond_json(
            200,
            {
                "id": "chatcmpl-fake",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "deepseek-chat",
                "choices": [
                    {"index": 0, "message": message, "finish_reason": finish}
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
        )


_server: ThreadingHTTPServer | None = None


def start_fake_deepseek_provider() -> ThreadingHTTPServer:
    """启动 Fake DeepSeek Provider（守护线程；E2E 后端进程退出即终止）。"""
    global _server
    if _server is not None:
        return _server
    _server = ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), _Handler)
    thread = threading.Thread(
        target=_server.serve_forever, daemon=True, name="fake-deepseek"
    )
    thread.start()
    return _server


def stop_fake_deepseek_provider() -> None:
    global _server
    if _server is not None:
        _server.shutdown()
        _server.server_close()
        _server = None
