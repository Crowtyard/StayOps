/**
 * E2E 测试用户准备（幂等）：
 * 以 admin 直连 E2E 后端（127.0.0.1:8001）创建 FRONT_DESK / HOUSEKEEPING 账号。
 *
 * 在测试的 beforeAll 中调用（而非 globalSetup），保证一定在 webServer 就绪、
 * 测试库重建完成后执行，避免 globalSetup 与 webServer 的启动顺序竞态。
 */

import { request } from "@playwright/test";
import { loadTestCredentials } from "./creds";

const BACKEND = "http://127.0.0.1:8001";

let prepared = false;

export async function ensureTestUsers(): Promise<void> {
  if (prepared) return;
  const creds = loadTestCredentials();

  const ctx = await request.newContext({ baseURL: BACKEND });
  try {
    const login = await ctx.post("/api/v1/auth/login", {
      data: { username: creds.adminUsername, password: creds.adminPassword },
    });
    if (!login.ok()) {
      throw new Error(
        `E2E admin 登录失败（${login.status()}）：${await login.text()}`,
      );
    }
    const token = (await login.json())["access_token"] as string;
    const headers = { Authorization: `Bearer ${token}` };

    const rolesResp = await ctx.get("/api/v1/roles", {
      headers,
      params: { page_size: 100 },
    });
    if (!rolesResp.ok()) {
      throw new Error(`读取角色失败（${rolesResp.status()}）`);
    }
    const roles = (await rolesResp.json())["items"] as {
      id: number;
      name: string;
    }[];
    const roleIdByName = new Map(roles.map((r) => [r.name, r.id]));

    const ensureUser = async (
      username: string,
      password: string,
      roleName: string,
    ): Promise<void> => {
      const usersResp = await ctx.get("/api/v1/users", {
        headers,
        params: { page_size: 100 },
      });
      if (!usersResp.ok()) {
        throw new Error(`读取用户失败（${usersResp.status()}）`);
      }
      const users = (await usersResp.json())["items"] as {
        id: number;
        username: string;
      }[];
      let user = users.find((u) => u.username === username);
      if (!user) {
        const create = await ctx.post("/api/v1/users", {
          headers,
          data: {
            username,
            password,
            display_name: username,
            is_active: true,
          },
        });
        if (!create.ok()) {
          throw new Error(
            `创建测试用户 ${username} 失败（${create.status()}）：${await create.text()}`,
          );
        }
        user = (await create.json()) as { id: number; username: string };
      }
      const roleId = roleIdByName.get(roleName);
      if (roleId === undefined) {
        throw new Error(`种子角色 ${roleName} 不存在`);
      }
      const assign = await ctx.post(`/api/v1/users/${user.id}/roles`, {
        headers,
        data: { role_ids: [roleId] },
      });
      if (!assign.ok()) {
        throw new Error(
          `为 ${username} 分配角色失败（${assign.status()}）：${await assign.text()}`,
        );
      }
    };

    await ensureUser(
      creds.frontdeskUsername,
      creds.frontdeskPassword,
      "FRONT_DESK",
    );
    await ensureUser(
      creds.housekeepingUsername,
      creds.housekeepingPassword,
      "HOUSEKEEPING",
    );
    // Sprint 5：维修运营 E2E 账号（MANAGER 派单/验收；MAINTENANCE 维修）
    await ensureUser(creds.managerUsername, creds.managerPassword, "MANAGER");
    await ensureUser(
      creds.maintenanceUsername,
      creds.maintenancePassword,
      "MAINTENANCE",
    );
    prepared = true;
  } finally {
    await ctx.dispose();
  }
}
