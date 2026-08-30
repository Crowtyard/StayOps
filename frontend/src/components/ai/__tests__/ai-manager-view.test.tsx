/**
 * AiManagerView 测试（Sprint 9 §8/§28/§42 Flow B/D）：
 * - 发送消息 -> 渲染回答；loading 状态
 * - AI_* 错误 -> 可读文案 + 重试
 * - 未配置 DeepSeek API -> 友好提示（有/无管理权限两种）
 * - 快捷问题 / 新对话
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { MeOut } from "@/lib/api/types";
import AiManagerView from "@/components/ai/ai-manager-view";
import { UserContext } from "@/components/app-shell";

const chatMock = vi.hoisted(() => vi.fn());
const messagesMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      ai: {
        chat: chatMock,
        messages: messagesMock,
      },
    },
  };
});

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "tester",
    display_name: null,
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: [{ id: 2, name: "MANAGER" }],
    permissions,
  };
}

function renderView(permissions: string[]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <AiManagerView />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  chatMock.mockReset();
  messagesMock.mockReset();
  messagesMock.mockRejectedValue(new Error("no history"));
  window.sessionStorage.clear();
});

describe("AiManagerView chat flow", () => {
  it("renders title, description and empty state", () => {
    renderView(["ai_manager:use"]);
    expect(screen.getByText("AI 店长")).toBeTruthy();
    expect(screen.getByText(/仅提供分析和建议/)).toBeTruthy();
    expect(screen.getByText(/我是 StayOps AI 店长/)).toBeTruthy();
  });

  it("shows six quick prompts", () => {
    renderView(["ai_manager:use"]);
    const buttons = screen.getAllByRole("button");
    const prompts = buttons.filter((b) =>
      /经营情况|未来7天|维修最多|换房次数|库存风险|采购情况/.test(
        b.textContent ?? "",
      ),
    );
    expect(prompts).toHaveLength(6);
  });

  it("sends a message and renders the answer", async () => {
    chatMock.mockResolvedValue({
      conversation_id: 7,
      answer: "最近30天入住率为 10%",
      model: "deepseek-chat",
      usage: null,
    });
    renderView(["ai_manager:use"]);
    const input = screen.getByLabelText("消息输入");
    await userEvent.type(input, "最近30天入住率怎么样？");
    await userEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(chatMock).toHaveBeenCalledWith({
      conversation_id: undefined,
      message: "最近30天入住率怎么样？",
    });
    await waitFor(() =>
      expect(screen.getByText("最近30天入住率为 10%")).toBeTruthy(),
    );
  });

  it("shows loading indicator while sending", async () => {
    let resolveChat: (value: unknown) => void = () => {};
    chatMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveChat = resolve;
        }),
    );
    renderView(["ai_manager:use"]);
    await userEvent.type(screen.getByLabelText("消息输入"), "你好");
    await userEvent.click(screen.getByRole("button", { name: "发送消息" }));
    expect(screen.getByRole("status")).toBeTruthy();
    resolveChat({
      conversation_id: 1,
      answer: "你好",
      model: "deepseek-chat",
      usage: null,
    });
    await waitFor(() => expect(screen.getByText("你好")).toBeTruthy());
  });

  it("shows readable error and retry re-sends last user message", async () => {
    chatMock
      .mockRejectedValueOnce(new ApiError("server", 502, "AI_TIMEOUT: x"))
      .mockResolvedValueOnce({
        conversation_id: 3,
        answer: "重试成功",
        model: "deepseek-chat",
        usage: null,
      });
    renderView(["ai_manager:use"]);
    await userEvent.type(screen.getByLabelText("消息输入"), "维修情况");
    await userEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "DeepSeek 请求超时，请重试",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(screen.getByText("重试成功")).toBeTruthy());
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(chatMock.mock.calls[1][0].message).toBe("维修情况");
  });

  it("shows not-configured notice with settings link for managers", async () => {
    renderView(["ai_manager:use", "ai_manager:manage"]);
    chatMock.mockRejectedValue(
      new ApiError("conflict", 409, "AI_NOT_CONFIGURED: 尚未配置 DeepSeek API"),
    );
    await userEvent.type(screen.getByLabelText("消息输入"), "你好");
    await userEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() =>
      expect(screen.getByTestId("ai-not-configured")).toBeTruthy(),
    );
    const link = screen.getByRole("link", { name: "前往 AI 设置" });
    expect(link.getAttribute("href")).toBe("/settings/ai");
  });

  it("shows not-configured notice without settings link for non-managers", async () => {
    renderView(["ai_manager:use"]);
    chatMock.mockRejectedValue(
      new ApiError("conflict", 409, "AI_NOT_CONFIGURED: 尚未配置 DeepSeek API"),
    );
    await userEvent.type(screen.getByLabelText("消息输入"), "你好");
    await userEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() =>
      expect(screen.getByTestId("ai-not-configured")).toBeTruthy(),
    );
    expect(screen.queryByRole("link", { name: "前往 AI 设置" })).toBeNull();
  });

  it("new conversation clears messages and session", async () => {
    chatMock.mockResolvedValue({
      conversation_id: 9,
      answer: "回答一",
      model: "deepseek-chat",
      usage: null,
    });
    renderView(["ai_manager:use"]);
    await userEvent.type(screen.getByLabelText("消息输入"), "问题");
    await userEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.getByText("回答一")).toBeTruthy());
    expect(window.sessionStorage.getItem("stayops_ai_conversation_id")).toBe("9");

    await userEvent.click(screen.getByRole("button", { name: "新对话" }));
    expect(
      window.sessionStorage.getItem("stayops_ai_conversation_id"),
    ).toBeNull();
    expect(screen.queryByText("回答一")).toBeNull();
  });
});
