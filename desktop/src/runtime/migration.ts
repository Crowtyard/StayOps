/**
 * Alembic 输出解析与迁移状态分类（纯函数）。
 *
 * 与 scripts/dev_runtime.py / scripts/desktop_runtime.py 的解析口径一致：
 * revision = 行首 12 位字母数字 token。
 */

export type MigrationState = "ok" | "behind" | "multi-head" | "unknown";

const REVISION_TOKEN = /^([0-9a-f]{12})\b/;

/** 从 `alembic current` 输出取最后一个 revision。 */
export function parseCurrent(output: string): string | null {
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i]!.match(REVISION_TOKEN);
    if (match) return match[1]!;
  }
  return null;
}

/** 从 `alembic heads` 输出取全部 revision（多 head 场景全部保留）。 */
export function parseHeads(output: string): string[] {
  const heads: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(REVISION_TOKEN);
    if (match && !heads.includes(match[1]!)) heads.push(match[1]!);
  }
  return heads;
}

/** 迁移状态分类：OK / BEHIND / MULTI_HEAD（Fail Safe）/ 解析失败。 */
export function classifyMigration(
  current: string | null,
  heads: readonly string[],
): MigrationState {
  if (current === null || heads.length === 0) return "unknown";
  if (heads.length > 1) return "multi-head";
  if (current !== heads[0]) return "behind";
  return "ok";
}
