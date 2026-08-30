/**
 * Preload（contextIsolation + sandbox）：
 * 只暴露 Desktop D1 §22 白名单 API——启动状态 / 事件订阅 / 重试 /
 * 确认迁移升级 / 打开日志 / 退出。
 * 无通用 execute / readFile / shell / process.env。
 *
 * 重要（sandbox 限制）：sandbox:true 的 preload 只能 require electron 内建
 * 模块，不能 require 相对路径文件（`module not found: ./runtime/bridge`）。
 * 因此 IPC 通道名与 Bridge 工厂直接内联在本文件；唯一来源仍为
 * src/runtime/ipc.ts 与 src/runtime/bridge.ts（单元测试覆盖），改动时须同步。
 */

import { contextBridge, ipcRenderer } from "electron";

// 与 src/runtime/ipc.ts 的 IPC 常量保持一致（勿分叉）
const IPC = {
  GetState: "startup:get-state",
  Events: "startup:events",
  Retry: "startup:retry",
  MigrationUpgrade: "startup:migration-upgrade",
  OpenLogs: "logs:open",
  Quit: "app:quit",
} as const;

interface StartupEventLike {
  type: string;
  [key: string]: unknown;
}

/** preload 只依赖的 ipcRenderer 能力子集（最小接口）。 */
interface BridgeIpc {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener: (channel: string, listener: (...args: unknown[]) => void) => unknown;
}

/** 构造白名单 Bridge（无通用 execute / readFile / shell / env）。 */
function createBridge(ipc: BridgeIpc): {
  getState: () => Promise<unknown>;
  onEvent: (callback: (event: StartupEventLike) => void) => () => void;
  retry: () => Promise<unknown>;
  migrationUpgrade: () => Promise<unknown>;
  openLogs: () => Promise<unknown>;
  quit: () => Promise<unknown>;
} {
  return {
    getState: () => ipc.invoke(IPC.GetState),
    onEvent: (callback) => {
      const listener = (...args: unknown[]): void => {
        const payload = args[1] as StartupEventLike | undefined;
        if (payload) callback(payload);
      };
      ipc.on(IPC.Events, listener);
      return () => {
        ipc.removeListener(IPC.Events, listener);
      };
    },
    retry: () => ipc.invoke(IPC.Retry),
    migrationUpgrade: () => ipc.invoke(IPC.MigrationUpgrade),
    openLogs: () => ipc.invoke(IPC.OpenLogs),
    quit: () => ipc.invoke(IPC.Quit),
  };
}

contextBridge.exposeInMainWorld("stayops", createBridge(ipcRenderer));
