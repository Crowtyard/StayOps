/**
 * SettingsAiView 测试（Sprint 9 §40/§42 Flow A）：
 * - 状态展示：configured / key_masked（sk-****abcd）/ model，无明文 Key
 * - 保存后输入框清空；Test Connection；Remove Key 确认
 * - 403 -> Forbidden
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApiError } from "@/lib/api";
import SettingsAiView from "@/components/ai/settings-ai-view";

const getSettingsMock = vi.hoisted(() => vi.fn());
const saveSettingsMock = vi.hoisted(() => vi.fn());
const deleteKeyMock = vi.hoisted(() => vi.fn());
const testConnectionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      ai: {
        getSettings: getSettingsMock,
        saveSettings: saveSettingsMock,
        deleteKey: deleteKeyMock,
        testConnection: testConnectionMock,
      },
    },
  };
});

const NOT_CONFIGURED = {
  provider: "deepseek",
  configured: false,
  key_masked: null,
  model: null,
};

const CONFIGURED = {
  provider: "deepseek",
  configured: true,
  key_masked: "sk-****abcd",
  model: "deepseek-chat",
};

beforeEach(() => {
  getSettingsMock.mockReset();
  saveSettingsMock.mockReset();
  deleteKeyMock.mockReset();
  testConnectionMock.mockReset();
});

describe("SettingsAiView", () => {
  it("shows not-configured state", async () => {
    getSettingsMock.mockResolvedValue(NOT_CONFIGURED);
    render(<SettingsAiView />);
    await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
    expect(screen.getByText("deepseek-chat（默认）")).toBeTruthy();
    expect(screen.queryByText("Remove Key")).toBeNull();
  });

  it("shows masked key and never the plaintext", async () => {
    getSettingsMock.mockResolvedValue(CONFIGURED);
    render(<SettingsAiView />);
    await waitFor(() =>
      expect(screen.getByText(/已配置 · sk-\*\*\*\*abcd/)).toBeTruthy(),
    );
    expect(screen.queryByText("sk-fake-secret-key-1234")).toBeNull();
  });

  it("saves config and clears the key input", async () => {
    getSettingsMock.mockResolvedValue(NOT_CONFIGURED);
    saveSettingsMock.mockResolvedValue(CONFIGURED);
    render(<SettingsAiView />);
    await waitFor(() => expect(screen.getByLabelText("DeepSeek API Key")).toBeTruthy());

    const keyInput = screen.getByLabelText("DeepSeek API Key") as HTMLInputElement;
    await userEvent.type(keyInput, "sk-new-secret-key-0000");
    const modelInput = screen.getByLabelText("Model") as HTMLInputElement;
    await userEvent.type(modelInput, "deepseek-chat");

    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saveSettingsMock).toHaveBeenCalledTimes(1));
    expect(saveSettingsMock.mock.calls[0][0]).toEqual({
      api_key: "sk-new-secret-key-0000",
      model: "deepseek-chat",
    });
    // 保存后输入框清空（§40）
    await waitFor(() => expect(keyInput.value).toBe(""));
    expect(screen.getByTestId("ai-settings-notice").textContent).toContain(
      "已安全保存",
    );
  });

  it("does not save when nothing changed (button disabled)", async () => {
    getSettingsMock.mockResolvedValue(NOT_CONFIGURED);
    render(<SettingsAiView />);
    await waitFor(() => expect(screen.getByLabelText("DeepSeek API Key")).toBeTruthy());
    const saveButton = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    await userEvent.click(saveButton);
    expect(saveSettingsMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ai-settings-notice")).toBeNull();
  });

  it("tests connection with typed key without saving", async () => {
    getSettingsMock.mockResolvedValue(NOT_CONFIGURED);
    testConnectionMock.mockResolvedValue({
      ok: true,
      model: "deepseek-chat",
      latency_ms: 88,
      usage: null,
    });
    render(<SettingsAiView />);
    await waitFor(() => expect(screen.getByLabelText("DeepSeek API Key")).toBeTruthy());
    await userEvent.type(screen.getByLabelText("DeepSeek API Key"), "sk-test-only");
    await userEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await waitFor(() =>
      expect(testConnectionMock).toHaveBeenCalledWith({ api_key: "sk-test-only" }),
    );
    expect(saveSettingsMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("ai-settings-notice").textContent).toContain(
        "连接成功",
      ),
    );
  });

  it("maps AI error codes on test failure", async () => {
    getSettingsMock.mockResolvedValue(NOT_CONFIGURED);
    testConnectionMock.mockRejectedValue(
      new ApiError("server", 502, "AI_AUTH_FAILED: key invalid"),
    );
    render(<SettingsAiView />);
    await waitFor(() => expect(screen.getByLabelText("DeepSeek API Key")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await waitFor(() =>
      expect(screen.getByTestId("ai-settings-notice").textContent).toContain(
        "API Key 无效",
      ),
    );
  });

  it("removes key after confirmation", async () => {
    getSettingsMock.mockResolvedValue(CONFIGURED);
    deleteKeyMock.mockResolvedValue(NOT_CONFIGURED);
    render(<SettingsAiView />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Key" })).toBeTruthy(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove Key" }));
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(deleteKeyMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
    expect(screen.getByTestId("ai-settings-notice").textContent).toContain(
      "API Key 已删除",
    );
  });

  it("renders Forbidden on 403", async () => {
    getSettingsMock.mockRejectedValue(
      new ApiError("forbidden", 403, "无权限执行该操作"),
    );
    render(<SettingsAiView />);
    await waitFor(() =>
      expect(screen.getByText("无权限访问该页面")).toBeTruthy(),
    );
  });
});
