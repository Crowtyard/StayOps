import { describe, expect, it, vi } from "vitest";
import { IPC, IPC_ALLOWLIST, PRELOAD_API_NAMES } from "../ipc";
import { createBridge, type BridgeIpc } from "../bridge";
import type { StartupEvent } from "../startup";

describe("ipc: 白名单通道（Desktop D1 §22）", () => {
  it("IPC 通道恰好为白名单集合", () => {
    expect(IPC_ALLOWLIST.sort()).toEqual(
      [
        "startup:get-state",
        "startup:events",
        "startup:retry",
        "startup:migration-upgrade",
        "logs:open",
        "app:quit",
      ].sort(),
    );
  });

  it("无通用执行通道（execute / readFile / shell / fs）", () => {
    const joined = IPC_ALLOWLIST.join(" ");
    expect(joined).not.toMatch(/execute|readFile|shell|child_process|fs:/i);
  });

  it("preload API 名恰好为白名单", () => {
    expect([...PRELOAD_API_NAMES].sort()).toEqual(
      ["getState", "onEvent", "migrationUpgrade", "openLogs", "quit", "retry"].sort(),
    );
  });

  it("不允许出现通用能力名", () => {
    const joined = PRELOAD_API_NAMES.join(" ");
    expect(joined).not.toMatch(/execute|readFile|spawn|writeFile|eval/i);
  });
});

describe("bridge: 暴露面白名单（createBridge 纯函数）", () => {
  function makeIpc(): { ipc: BridgeIpc; invoke: ReturnType<typeof vi.fn> } {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const on = vi.fn();
    const removeListener = vi.fn();
    return { ipc: { invoke, on, removeListener }, invoke };
  }

  it("只暴露白名单 API，无通用能力", () => {
    const { ipc } = makeIpc();
    const api = createBridge(ipc);
    expect(Object.keys(api).sort()).toEqual([...PRELOAD_API_NAMES].sort());
    const joined = Object.keys(api).join(" ");
    expect(joined).not.toMatch(/execute|readFile|spawn|writeFile|eval|shell/i);
  });

  it("每个 API 只调用白名单 IPC 通道", () => {
    const { ipc, invoke } = makeIpc();
    const api = createBridge(ipc);
    void api.getState();
    expect(invoke).toHaveBeenCalledWith(IPC.GetState);
    void api.retry();
    expect(invoke).toHaveBeenCalledWith(IPC.Retry);
    void api.migrationUpgrade();
    expect(invoke).toHaveBeenCalledWith(IPC.MigrationUpgrade);
    void api.openLogs();
    expect(invoke).toHaveBeenCalledWith(IPC.OpenLogs);
    void api.quit();
    expect(invoke).toHaveBeenCalledWith(IPC.Quit);
    // 事件订阅只监听 Events 通道
    api.onEvent(() => {});
    expect(ipc.on).toHaveBeenCalledWith(IPC.Events, expect.any(Function));
  });

  it("onEvent 转发事件并返回取消订阅函数", () => {
    const { ipc } = makeIpc();
    const api = createBridge(ipc);
    const received: StartupEvent[] = [];
    const unsubscribe = api.onEvent((e) => received.push(e));
    // 模拟主进程推送
    const listener = (ipc.on as ReturnType<typeof vi.fn>).mock.calls[0]![1] as (
      ...args: unknown[]
    ) => void;
    const event: StartupEvent = { type: "phase", phase: "env", status: "ok" };
    listener({}, event);
    expect(received).toEqual([event]);
    unsubscribe();
    expect(ipc.removeListener).toHaveBeenCalledWith(IPC.Events, listener);
  });
});
