/**
 * Preload Bridge 工厂（纯函数，不依赖 electron）：
 * 把 IPC 白名单 API 绑定到给定的 ipcRenderer 子集。
 * preload.ts 仅负责把它暴露给 renderer；本模块可被单元测试直接覆盖。
 */

import { IPC } from "./ipc";
import type { StartupEvent } from "./startup";

/** preload 只依赖的 ipcRenderer 能力子集（最小接口）。 */
export interface BridgeIpc {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener: (channel: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface StayOpsBridgeApi {
  getState: () => Promise<unknown>;
  onEvent: (callback: (event: StartupEvent) => void) => () => void;
  retry: () => Promise<unknown>;
  migrationUpgrade: () => Promise<unknown>;
  openLogs: () => Promise<unknown>;
  quit: () => Promise<unknown>;
}

/** 构造白名单 Bridge（无通用 execute / readFile / shell / env）。 */
export function createBridge(ipc: BridgeIpc): StayOpsBridgeApi {
  return {
    getState: () => ipc.invoke(IPC.GetState),
    onEvent: (callback) => {
      const listener = (...args: unknown[]): void => {
        const payload = args[1] as StartupEvent | undefined;
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
