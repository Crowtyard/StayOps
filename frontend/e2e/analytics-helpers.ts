/**
 * S8 Analytics E2E 辅助（真实链路，禁止 Mock）：
 * - 数据构造：admin 直连 8001 后端 API（booking / housekeeping / maintenance /
 *   inventory / procurement 全真实链路）
 * - 历史房晚状态准备：setup_backdate_stay.py 真实 UPDATE（与 setup_overdue_stay.py 同模式）
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect } from "@playwright/test";
import {
  adminApi,
  apiGetRoomByNumber,
  businessDate,
  closeApi,
  todayPlus,
  type ApiSession,
  type RoomApi,
} from "./booking-helpers";

export const ANALYTICS_ROOM = "401";

export interface StaySeedResult {
  stayId: number;
  reservationId: number;
}

export async function apiCreateGuest(api: ApiSession, name = "分析E2E客"): Promise<number> {
  const resp = await api.ctx.post("/api/v1/guests", {
    headers: api.headers,
    data: { name, phone: "13700001111", email: "e2e@example.com" },
  });
  expect(resp.status(), `创建客人失败：${await resp.text()}`).toBe(201);
  return ((await resp.json()) as { id: number }).id;
}

export async function apiCreateReservation(
  api: ApiSession,
  room: RoomApi,
  guestId: number,
  amount: string,
): Promise<number> {
  const resp = await api.ctx.post("/api/v1/reservations", {
    headers: api.headers,
    data: {
      guest_id: guestId,
      room_id: room.id,
      room_type_id: room.room_type_id,
      check_in_date: businessDate(),
      check_out_date: todayPlus(2),
      source: "DIRECT",
      agreed_total_amount: amount,
      currency: "CNY",
    },
  });
  expect(resp.status(), `创建预订失败：${await resp.text()}`).toBe(201);
  return ((await resp.json()) as { id: number }).id;
}

/** 预订 -> 入住 -> 退房（生成 1 个完成 Stay + CHECKOUT 保洁任务） */
export async function apiCreateCompletedStay(
  api: ApiSession,
  room: RoomApi,
  amount = "600.00",
): Promise<StaySeedResult> {
  const guestId = await apiCreateGuest(api);
  const reservationId = await apiCreateReservation(api, room, guestId, amount);
  const ci = await api.ctx.post(`/api/v1/reservations/${reservationId}/check-in`, {
    headers: api.headers,
  });
  expect(ci.status(), `入住失败：${await ci.text()}`).toBe(200);
  const stayId = ((await ci.json()) as { stay: { id: number } }).stay.id;
  const co = await api.ctx.post(`/api/v1/stays/${stayId}/check-out`, {
    headers: api.headers,
  });
  expect(co.status(), `退房失败：${await co.text()}`).toBe(200);
  return { stayId, reservationId };
}

/** 真实 UPDATE：actual_check_in_at 回填到 N 天前 14:00（产生 N 个历史房晚）。
 *  Safety（D2 同口径）：显式传入 E2E 测试库连接（脚本无默认连接目标）。 */
export function backdateStay(stayId: number, daysAgo: number): void {
  const python = path.resolve(__dirname, "..", "..", "backend", ".venv", "Scripts", "python.exe");
  const script = path.resolve(__dirname, "setup_backdate_stay.py");
  const out = execFileSync(python, [script, String(stayId), String(daysAgo)], {
    encoding: "utf8",
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      DATABASE_URL: "postgresql+psycopg2://stayops:change-me@localhost:5432/stayops_test",
    },
  });
  expect(out.trim(), "回填实际入住时刻失败").toMatch(/^OK /);
}

/** 真实 UPDATE：把 Analytics E2E 显式创建的流水/收货行时间回填到昨天
 *  （Actual 区间不含今天，§3）。Safety（D2）：只传本次创建的显式行 ID，
 *  脚本硬性校验数据库名 == stayops_test，禁止作用于开发库。 */
export function backdateProcurement(
  receiptIds: number[],
  movementIds: number[],
): void {
  const python = path.resolve(__dirname, "..", "..", "backend", ".venv", "Scripts", "python.exe");
  const script = path.resolve(__dirname, "setup_backdate_procurement.py");
  const args: string[] = [script];
  for (const id of receiptIds) args.push("--receipt-id", String(id));
  for (const id of movementIds) args.push("--movement-id", String(id));
  const out = execFileSync(python, args, {
    encoding: "utf8",
    cwd: path.resolve(__dirname, ".."),
    // E2E 专用测试库（脚本不提供默认连接目标；显式传入保证与 E2E 后端同库）
    env: {
      ...process.env,
      DATABASE_URL: "postgresql+psycopg2://stayops:change-me@localhost:5432/stayops_test",
    },
  });
  expect(out.trim(), "回填库存/收货时间失败").toMatch(/^OK /);
}

/** 完成房间的 CHECKOUT 保洁任务（退房自动任务 -> start/pass 全链路） */
export async function apiCompleteHousekeeping(api: ApiSession, roomId: number): Promise<void> {
  const list = await api.ctx.get("/api/v1/housekeeping/tasks", {
    headers: api.headers,
    params: { room_id: roomId, page_size: 100 },
  });
  expect(list.status(), `读取保洁任务失败：${await list.text()}`).toBe(200);
  const tasks = ((await list.json()) as { items: { id: number; status: string }[] }).items;
  const task = tasks.find((t) => t.status === "PENDING" || t.status === "IN_PROGRESS");
  expect(task, "退房后应存在待处理保洁任务").toBeTruthy();
  for (const action of ["start", "submit-inspection", "pass"]) {
    const resp = await api.ctx.post(`/api/v1/housekeeping/tasks/${task!.id}/${action}`, {
      headers: api.headers,
    });
    expect(resp.status(), `保洁动作 ${action} 失败：${await resp.text()}`).toBe(200);
  }
}

/** 创建阻断性维修工单（OPEN + blocks_room；须在 backdateStay 之前调用以便一并回填） */
export async function apiCreateBlockingMaintenance(
  api: ApiSession,
  room: RoomApi,
): Promise<void> {
  const resp = await api.ctx.post("/api/v1/maintenance/orders", {
    headers: api.headers,
    data: {
      room_id: room.id,
      category: "HVAC",
      severity: "HIGH",
      blocks_room: true,
      source: "MANUAL",
      title: "E2E 分析空调故障",
    },
  });
  expect(resp.status(), `创建维修工单失败：${await resp.text()}`).toBe(201);
}

/** 构造库存 + 采购数据：物资 -> 期初 -> 领用 -> 订单 -> 收货。
 *  返回本次流程创建的行 ID（供 backdateProcurement 显式指定，D2.2）。 */
export async function apiSeedInventoryProcurement(api: ApiSession): Promise<{
  receiptIds: number[];
  movementIds: number[];
}> {
  const locResp = await api.ctx.get("/api/v1/inventory/locations", {
    headers: api.headers,
    params: { page_size: 100 },
  });
  const locations = ((await locResp.json()) as {
    items: { id: number; location_code: string }[];
  }).items;
  const main = locations.find((l) => l.location_code === "MAIN_STORAGE");
  expect(main, "缺少 MAIN_STORAGE 地点").toBeTruthy();

  const itemResp = await api.ctx.post("/api/v1/inventory/items", {
    headers: api.headers,
    data: {
      item_code: "E2E-ANA-WATER",
      name: "分析矿泉水",
      category: "GUEST_AMENITY",
      base_unit: "瓶",
      minimum_stock: "10",
      target_stock: "50",
    },
  });
  expect(itemResp.status(), `创建物资失败：${await itemResp.text()}`).toBe(201);
  const item = (await itemResp.json()) as { id: number };

  const initial = await api.ctx.post(`/api/v1/inventory/items/${item.id}/initial-stock`, {
    headers: api.headers,
    data: { location_id: main!.id, quantity: "50" },
  });
  expect(initial.status(), `期初库存失败：${await initial.text()}`).toBe(200);

  const issue = await api.ctx.post("/api/v1/inventory/issues", {
    headers: api.headers,
    data: {
      source_location_id: main!.id,
      destination_type: "HOUSEKEEPING",
      lines: [{ item_id: item.id, quantity: "8" }],
    },
  });
  expect(issue.status(), `领用失败：${await issue.text()}`).toBe(201);

  const supplierResp = await api.ctx.post("/api/v1/procurement/suppliers", {
    headers: api.headers,
    data: { supplier_code: "E2E-ANA-SUP", name: "分析供应商", phone: "13911110000" },
  });
  expect(supplierResp.status(), `创建供应商失败：${await supplierResp.text()}`).toBe(201);
  const supplier = (await supplierResp.json()) as { id: number };

  const poResp = await api.ctx.post("/api/v1/procurement/orders", {
    headers: api.headers,
    data: {
      supplier_id: supplier.id,
      lines: [{ item_id: item.id, ordered_quantity: "100", unit_price: "1.50" }],
    },
  });
  expect(poResp.status(), `创建订单失败：${await poResp.text()}`).toBe(201);
  const po = (await poResp.json()) as { id: number };
  const ordered = await api.ctx.post(`/api/v1/procurement/orders/${po.id}/order`, {
    headers: api.headers,
  });
  expect(ordered.status(), `下达订单失败：${await ordered.text()}`).toBe(200);
  const poDetailResp = await api.ctx.get(`/api/v1/procurement/orders/${po.id}`, {
    headers: api.headers,
  });
  const poDetail = (await poDetailResp.json()) as {
    lines: { id: number; item_id: number }[];
  };
  const line = poDetail.lines.find((l) => l.item_id === item.id);
  const receipt = await api.ctx.post(`/api/v1/procurement/orders/${po.id}/receipts`, {
    headers: api.headers,
    data: {
      inventory_location_id: main!.id,
      lines: [{ purchase_order_line_id: line!.id, received_quantity: "40" }],
    },
  });
  expect(receipt.status(), `收货失败：${await receipt.text()}`).toBe(201);
  const receiptId = ((await receipt.json()) as { id: number }).id;

  // 本次流程创建的流水（按 E2E 物资过滤，全部属于本测试）
  const movementsResp = await api.ctx.get("/api/v1/inventory/movements", {
    headers: api.headers,
    params: { item_id: item.id, page_size: 100 },
  });
  const movements = ((await movementsResp.json()) as {
    items: { id: number }[];
  }).items;
  expect(movements.length, "E2E 物资应有 INITIAL/ISSUE/PURCHASE_RECEIPT 流水").toBeGreaterThanOrEqual(3);
  return {
    receiptIds: [receiptId],
    movementIds: movements.map((m) => m.id),
  };
}

/**
 * 归一化房间：取消 CONFIRMED 预订 / 退房 ACTIVE Stay / 取消进行中保洁任务 /
 * 取消进行中维修工单 / 恢复 available+clean（与 maintenance.spec 的
 * 301-308 归一化策略一致；本 spec 运行在最后，需自行清理前面 spec 的残留）。
 */
export async function apiNormalizeRoom(api: ApiSession, roomNumber: string): Promise<void> {
  const room = await apiGetRoomByNumber(api, roomNumber);
  const roomId = room.id as number;
  const reservations = await api.ctx.get("/api/v1/reservations", {
    headers: api.headers,
    params: { room_id: roomId, page_size: 100 },
  });
  for (const r of ((await reservations.json()) as { items: { id: number; status: string }[] }).items) {
    if (r.status === "CONFIRMED") {
      await api.ctx.post(`/api/v1/reservations/${r.id}/cancel`, { headers: api.headers });
    }
  }
  const stays = await api.ctx.get("/api/v1/stays", {
    headers: api.headers,
    params: { room_id: roomId, status: "ACTIVE", page_size: 100 },
  });
  for (const s of ((await stays.json()) as { items: { id: number }[] }).items) {
    const co = await api.ctx.post(`/api/v1/stays/${s.id}/check-out`, { headers: api.headers });
    expect(co.status(), `归一化退房失败：${await co.text()}`).toBe(200);
  }
  const tasks = await api.ctx.get("/api/v1/housekeeping/tasks", {
    headers: api.headers,
    params: { room_id: roomId, page_size: 100 },
  });
  for (const t of ((await tasks.json()) as {
    items: { id: number; status: string }[];
  }).items) {
    if (["PENDING", "IN_PROGRESS", "INSPECTION", "REWORK"].includes(t.status)) {
      const cancel = await api.ctx.post(`/api/v1/housekeeping/tasks/${t.id}/cancel`, {
        headers: api.headers,
      });
      expect(cancel.status(), `归一化取消保洁任务失败：${await cancel.text()}`).toBe(200);
    }
  }
  const orders = await api.ctx.get("/api/v1/maintenance/orders", {
    headers: api.headers,
    params: { room_id: roomId, page_size: 100 },
  });
  for (const o of ((await orders.json()) as {
    items: { id: number; status: string }[];
  }).items) {
    if (!["COMPLETED", "CANCELLED"].includes(o.status)) {
      const cancel = await api.ctx.post(`/api/v1/maintenance/orders/${o.id}/cancel`, {
        headers: api.headers,
      });
      expect(cancel.status(), `归一化取消维修工单失败：${await cancel.text()}`).toBe(200);
    }
  }
  // 房态恢复：占用 -> available（先取消动作后重新读取，避免 stale 状态 409；
  // 清洁维度走状态机：dirty -> cleaning -> clean）
  const roomNow = await apiGetRoomByNumber(api, roomNumber);
  const statusBody: Record<string, string> = {};
  if (roomNow.occupancy_status !== "available") {
    statusBody.occupancy_status = "available";
  }
  if (Object.keys(statusBody).length > 0) {
    const resp = await api.ctx.post(`/api/v1/rooms/${roomNow.id}/status`, {
      headers: api.headers,
      data: statusBody,
    });
    expect(resp.status(), `归一化房态失败：${await resp.text()}`).toBe(200);
  }
  const room2 = await apiGetRoomByNumber(api, roomNumber);
  if (room2.cleaning_status === "dirty" || room2.cleaning_status === "rework") {
    // 状态机：dirty/rework -> cleaning（rework -> clean 非法）
    const step1 = await api.ctx.post(`/api/v1/rooms/${room2.id}/status`, {
      headers: api.headers,
      data: { cleaning_status: "cleaning" },
    });
    expect(step1.status(), `归一化清洁状态失败：${await step1.text()}`).toBe(200);
  }
  const room3 = await apiGetRoomByNumber(api, roomNumber);
  if (room3.cleaning_status !== "clean") {
    const step2 = await api.ctx.post(`/api/v1/rooms/${room3.id}/status`, {
      headers: api.headers,
      data: { cleaning_status: "clean" },
    });
    expect(step2.status(), `归一化清洁状态失败：${await step2.text()}`).toBe(200);
  }
}

/** 创建 FINANCE 测试账号（幂等：已存在则复用） */
export async function ensureFinanceUser(): Promise<void> {
  const api = await adminApi();
  try {
    const usersResp = await api.ctx.get("/api/v1/users", {
      headers: api.headers,
      params: { page_size: 100 },
    });
    const users = ((await usersResp.json()) as { items: { username: string }[] }).items;
    if (users.some((u) => u.username === "e2e_finance")) return;
    const create = await api.ctx.post("/api/v1/users", {
      headers: api.headers,
      data: { username: "e2e_finance", password: "Finance@123456", display_name: "财务" },
    });
    expect(create.status(), `创建财务账号失败：${await create.text()}`).toBe(201);
    const user = (await create.json()) as { id: number };
    const rolesResp = await api.ctx.get("/api/v1/roles", {
      headers: api.headers,
      params: { page_size: 100 },
    });
    const roles = ((await rolesResp.json()) as { items: { id: number; name: string }[] }).items;
    const financeRole = roles.find((r) => r.name === "FINANCE");
    expect(financeRole, "种子角色 FINANCE 应存在").toBeTruthy();
    const assign = await api.ctx.post(`/api/v1/users/${user.id}/roles`, {
      headers: api.headers,
      data: { role_ids: [financeRole!.id] },
    });
    expect(assign.status(), `分配 FINANCE 角色失败：${await assign.text()}`).toBe(200);
  } finally {
    await closeApi(api);
  }
}

export { apiGetRoomByNumber, adminApi, closeApi, businessDate, todayPlus };
