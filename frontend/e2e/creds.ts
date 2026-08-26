/**
 * E2E 测试凭据加载。
 *
 * 凭据只存放在 gitignored 的 frontend/e2e/.env.test-creds（禁止入库）。
 * 模板见同目录 test-creds.example。缺失时给出可读错误并终止。
 */

import fs from "node:fs";
import path from "node:path";

export interface TestCredentials {
  adminUsername: string;
  adminPassword: string;
  frontdeskUsername: string;
  frontdeskPassword: string;
  housekeepingUsername: string;
  housekeepingPassword: string;
}

const REQUIRED_KEYS = [
  "E2E_ADMIN_USERNAME",
  "E2E_ADMIN_PASSWORD",
  "E2E_FRONT_DESK_USERNAME",
  "E2E_FRONT_DESK_PASSWORD",
  "E2E_HOUSEKEEPING_USERNAME",
  "E2E_HOUSEKEEPING_PASSWORD",
] as const;

type EnvMap = Record<(typeof REQUIRED_KEYS)[number], string>;

function parseDotEnv(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    map[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return map;
}

export function loadTestCredentials(): TestCredentials {
  const file = path.join(__dirname, ".env.test-creds");
  if (!fs.existsSync(file)) {
    throw new Error(
      `缺少 E2E 凭据文件 ${file}。请复制同目录 test-creds.example 为 .env.test-creds 并填入真实值（该文件已被 .gitignore 忽略，不会入库）。`,
    );
  }
  const map = parseDotEnv(fs.readFileSync(file, "utf-8"));
  const missing = REQUIRED_KEYS.filter((k) => !map[k]);
  if (missing.length > 0) {
    throw new Error(`E2E 凭据文件缺少以下键：${missing.join(", ")}`);
  }
  const env = map as EnvMap;
  return {
    adminUsername: env.E2E_ADMIN_USERNAME,
    adminPassword: env.E2E_ADMIN_PASSWORD,
    frontdeskUsername: env.E2E_FRONT_DESK_USERNAME,
    frontdeskPassword: env.E2E_FRONT_DESK_PASSWORD,
    housekeepingUsername: env.E2E_HOUSEKEEPING_USERNAME,
    housekeepingPassword: env.E2E_HOUSEKEEPING_PASSWORD,
  };
}
