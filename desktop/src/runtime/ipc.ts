/**
 * IPC 白名单（Desktop D1 §22）：
 * Renderer 只能经 preload 暴露的这组通道与主进程通信，
 * 无通用 execute / readFile / shell。
 */

export const IPC = {
  /** renderer → main：取当前启动状态快照 */
  GetState: "startup:get-state",
  /** main → renderer：启动阶段事件推送 */
  Events: "startup:events",
  /** renderer → main：重新检查并启动 */
  Retry: "startup:retry",
  /** renderer → main：用户确认升级数据库 */
  MigrationUpgrade: "startup:migration-upgrade",
  /** renderer → main：打开日志目录 */
  OpenLogs: "logs:open",
  /** renderer → main：退出桌面应用 */
  Quit: "app:quit",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** 白名单通道集合（测试断言 preload 恰好暴露这些通道）。 */
export const IPC_ALLOWLIST: readonly string[] = Object.values(IPC);

/** Preload 暴露的顶层 API 名（白名单）。 */
export const PRELOAD_API_NAMES = [
  "getState",
  "onEvent",
  "retry",
  "migrationUpgrade",
  "openLogs",
  "quit",
] as const;
