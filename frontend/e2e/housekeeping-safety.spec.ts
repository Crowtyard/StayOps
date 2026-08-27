/**
 * S3 Housekeeping 安全专项（正式 E2E，HTTP 层，真实 FastAPI + stayops_test）：
 *
 * 1. Check-in clean gating：dirty / cleaning / inspection / rework → 409；clean → SUCCESS
 *    （房间 105-108 非 clean 状态；109 clean 成功 → 退房 → 自动任务 → 完成链 → 恢复 clean）
 * 2. RBAC 矩阵：FRONT_DESK 可创建/派单，不可 start/cancel；HOUSEKEEPING 可执行工作流，
 *    不可创建/修改/取消；MAINTENANCE 全 403；assignees 端点权限
 * 3. 并发：Duplicate Active Task（部分唯一索引最终仲裁）、Concurrent Start、
 *    Concurrent PASS vs REWORK（恰一个成功，无矛盾终态）
 * 4. PII：任务响应与审计不含任何 Guest 身份/联系方式/预订数据
 */

import { expect, test } from "@playwright/test";
import { ensureTestUsers } from "./setup-users";
import {
  addDays,
  adminApi,
  apiCheckIn,
  apiCreateGuest,
  apiCreateReservation,
  apiExpectRoomState,
  apiGetRoomByNumber,
  apiSetRoomStatus,
  businessDate,
  closeApi,
  frontdeskApi,
  type ApiSession,
} from "./booking-helpers";
import {
  apiAssignTask,
  apiCompleteTaskChain,
  apiCreateTask,
  apiGetActiveTaskByRoom,
  apiGetTask,
  apiListTasks,
  apiTaskAction,
} from "./housekeeping-helpers";

const CHECK_IN = businessDate();
const CHECK_OUT = addDays(CHECK_IN, 2);

test.beforeAll(() => ensureTestUsers());

async function makeReservationOn(
  api: ApiSession,
  roomNumber: string,
  guestName: string,
) {
  const guest = await apiCreateGuest(api, { name: guestName, phone: "13900006666" });
  const room = await apiGetRoomByNumber(api, roomNumber);
  return apiCreateReservation(api, {
    guest_id: guest.id,
    room_id: room.id,
    room_type_id: room.room_type_id,
    check_in_date: CHECK_IN,
    check_out_date: CHECK_OUT,
    agreed_total_amount: "399.00",
  });
}

/** 沿合法清洁状态机路径构造房间状态：dirty → cleaning → inspection → rework */
async function setCleaningPath(
  api: ApiSession,
  roomNumber: string,
  path: string[],
) {
  const room = await apiGetRoomByNumber(api, roomNumber);
  for (const status of path) {
    await apiSetRoomStatus(api, room.id, { cleaning_status: status });
  }
}

test("Check-in gating：dirty/cleaning/inspection/rework → 409；clean → SUCCESS", async () => {
  const api = await adminApi();

  // 非 clean 状态门禁（房间 105-108）
  const cases: { status: string; room: string }[] = [
    { status: "dirty", room: "105" },
    { status: "cleaning", room: "106" },
    { status: "inspection", room: "107" },
    { status: "rework", room: "108" },
  ];
  for (const c of cases) {
    const reservation = await makeReservationOn(api, c.room, `门禁客人-${c.status}`);
    await setCleaningPath(
      api,
      c.room,
      c.status === "dirty"
        ? ["dirty"]
        : c.status === "cleaning"
          ? ["dirty", "cleaning"]
          : c.status === "inspection"
            ? ["dirty", "cleaning", "inspection"]
            : ["dirty", "cleaning", "inspection", "rework"],
    );
    const resp = await api.ctx.post(
      `/api/v1/reservations/${reservation.id}/check-in`,
      { headers: api.headers },
    );
    expect(resp.status(), `房间 ${c.room}（${c.status}）入住应为 409`).toBe(409);
    const body = (await resp.json()) as { detail?: string };
    expect(body.detail).toContain("未清洁");
  }

  // clean 房间（109）：SUCCESS → 退房 → 自动任务 → 完成链 → 恢复 clean（供后续用例）
  const cleanReservation = await makeReservationOn(api, "109", "门禁客人-clean");
  const checked = await apiCheckIn(api, cleanReservation.id);
  expect(checked.reservation.status).toBe("CHECKED_IN");

  const checkoutResp = await api.ctx.post(
    `/api/v1/stays/${checked.stay.id}/check-out`,
    { headers: api.headers },
  );
  expect(checkoutResp.status()).toBe(200);
  const task = await apiGetActiveTaskByRoom(api, "109");
  expect(task.source).toBe("CHECKOUT");
  await apiCompleteTaskChain(api, task.id);
  expect((await apiGetTask(api, task.id)).status).toBe("COMPLETED");
  await apiExpectRoomState(api, "109", "available", "clean");

  await closeApi(api);
});

test("RBAC 矩阵：create/assign/start/cancel 按角色放行或 403", async () => {
  const admin = await adminApi();
  const fd = await frontdeskApi();

  // 105 在 gating 后为 dirty 且无任务：FRONT_DESK 可手动创建
  const room105 = await apiGetRoomByNumber(admin, "105");
  const task = await apiCreateTask(fd, room105.id, { priority: "URGENT" });
  expect(task.source).toBe("MANUAL");

  // FRONT_DESK：派单（write）✓；start / cancel → 403
  const hkUsers = await admin.ctx.get("/api/v1/users", {
    headers: admin.headers,
    params: { page: 1, page_size: 100 },
  });
  const hkUserId = ((await hkUsers.json()) as { items: { id: number; username: string }[] })
    .items.find((u) => u.username === process.env.E2E_HOUSEKEEPING_USERNAME)?.id;
  expect(hkUserId).toBeTruthy();
  await apiAssignTask(fd, task.id, hkUserId as number);

  const fdStart = await fd.ctx.post(`/api/v1/housekeeping/tasks/${task.id}/start`, {
    headers: fd.headers,
  });
  expect(fdStart.status()).toBe(403);
  const fdCancel = await fd.ctx.post(`/api/v1/housekeeping/tasks/${task.id}/cancel`, {
    headers: fd.headers,
  });
  expect(fdCancel.status()).toBe(403);

  // HOUSEKEEPING：start/submit/pass ✓；create/PATCH/cancel → 403
  const hkLogin = await fd.ctx.post("/api/v1/auth/login", {
    data: {
      username: process.env.E2E_HOUSEKEEPING_USERNAME,
      password: process.env.E2E_HOUSEKEEPING_PASSWORD,
    },
  });
  const hkToken = ((await hkLogin.json()) as { access_token: string }).access_token;
  const hk = {
    ctx: fd.ctx,
    headers: { Authorization: `Bearer ${hkToken}` },
  };

  await apiTaskAction(hk, task.id, "start");
  await apiTaskAction(hk, task.id, "submit-inspection");
  await apiTaskAction(hk, task.id, "pass");
  expect((await apiGetTask(admin, task.id)).status).toBe("COMPLETED");

  const hkCreate = await hk.ctx.post("/api/v1/housekeeping/tasks", {
    headers: hk.headers,
    data: { room_id: room105.id },
  });
  expect(hkCreate.status()).toBe(403);
  const hkPatch = await hk.ctx.patch(`/api/v1/housekeeping/tasks/${task.id}`, {
    headers: hk.headers,
    data: { priority: "NORMAL" },
  });
  expect(hkPatch.status()).toBe(403);

  // assignees：FRONT_DESK 200（含 work 用户）；HOUSEKEEPING 403
  const fdAssignees = await fd.ctx.get("/api/v1/housekeeping/assignees", {
    headers: fd.headers,
  });
  expect(fdAssignees.status()).toBe(200);
  const assigneeNames = ((await fdAssignees.json()) as { username: string }[]).map(
    (a) => a.username,
  );
  expect(assigneeNames).toContain(process.env.E2E_HOUSEKEEPING_USERNAME);
  const hkAssignees = await hk.ctx.get("/api/v1/housekeeping/assignees", {
    headers: hk.headers,
  });
  expect(hkAssignees.status()).toBe(403);

  // MAINTENANCE：任务域全部 403（无任务权限账号）
  const createMaint = await fd.ctx.post("/api/v1/users", {
    headers: admin.headers,
    data: {
      username: "e2e_maint_s3",
      password: "Maint@123456",
      display_name: "e2e_maint_s3",
      is_active: true,
    },
  });
  if (createMaint.status() !== 201) {
    // 幂等：已存在（同一次运行内重复执行）
    expect(createMaint.status()).toBe(409);
  }
  const maintLogin = await fd.ctx.post("/api/v1/auth/login", {
    data: { username: "e2e_maint_s3", password: "Maint@123456" },
  });
  const maintToken = ((await maintLogin.json()) as { access_token: string }).access_token;
  const maintGet = await fd.ctx.get("/api/v1/housekeeping/tasks", {
    headers: { Authorization: `Bearer ${maintToken}` },
  });
  expect(maintGet.status()).toBe(403);

  await closeApi(fd);
  await closeApi(admin);
});

test("并发：Duplicate Active Task / Concurrent Start / PASS vs REWORK", async () => {
  const api = await adminApi();
  const apiB = await adminApi();

  // 准备：105 当前 clean（上一步已通过验房）→ dirty
  const room105 = await apiGetRoomByNumber(api, "105");
  if (room105.cleaning_status !== "dirty") {
    await apiSetRoomStatus(api, room105.id, { cleaning_status: "dirty" });
  }

  /* 1) Duplicate Active Task：两个并发创建 → 1 × 201 + 1 × 409，库中恰 1 个进行中任务 */
  const payload = { room_id: room105.id, priority: "NORMAL" };
  const [c1, c2] = await Promise.all([
    api.ctx.post("/api/v1/housekeeping/tasks", {
      headers: api.headers,
      data: payload,
    }),
    apiB.ctx.post("/api/v1/housekeeping/tasks", {
      headers: apiB.headers,
      data: payload,
    }),
  ]);
  expect([c1.status(), c2.status()].sort()).toEqual([201, 409]);
  const conflict = c1.status() === 409 ? c1 : c2;
  expect(((await conflict.json()) as { detail?: string }).detail).toContain(
    "已有进行中的保洁任务",
  );
  const active = await apiGetActiveTaskByRoom(api, "105");
  expect(active.status).toBe("PENDING");
  const taskId = active.id;

  /* 2) Concurrent Start：1 × 200 + 1 × 409，最终 IN_PROGRESS + 房间 cleaning */
  const [s1, s2] = await Promise.all([
    api.ctx.post(`/api/v1/housekeeping/tasks/${taskId}/start`, { headers: api.headers }),
    apiB.ctx.post(`/api/v1/housekeeping/tasks/${taskId}/start`, { headers: apiB.headers }),
  ]);
  expect([s1.status(), s2.status()].sort()).toEqual([200, 409]);
  expect((await apiGetTask(api, taskId)).status).toBe("IN_PROGRESS");
  await apiExpectRoomState(api, "105", "available", "cleaning");

  await apiTaskAction(api, taskId, "submit-inspection");
  await apiExpectRoomState(api, "105", "available", "inspection");

  /* 3) Concurrent Inspection Decision：PASS vs REWORK → 恰一个成功，无矛盾终态 */
  const [p1, r1] = await Promise.all([
    api.ctx.post(`/api/v1/housekeeping/tasks/${taskId}/pass`, { headers: api.headers }),
    apiB.ctx.post(`/api/v1/housekeeping/tasks/${taskId}/rework`, { headers: apiB.headers }),
  ]);
  const statuses = [p1.status(), r1.status()].sort();
  expect(statuses).toEqual([200, 409]);

  const finalTask = await apiGetTask(api, taskId);
  const roomFinal = await apiGetRoomByNumber(api, "105");
  if (finalTask.status === "COMPLETED") {
    expect(roomFinal.cleaning_status).toBe("clean");
  } else if (finalTask.status === "REWORK") {
    expect(roomFinal.cleaning_status).toBe("rework");
  } else {
    throw new Error(`非法终态：${finalTask.status}`);
  }
  // 不允许矛盾组合：COMPLETED + rework / REWORK + clean
  expect(
    !(
      (finalTask.status === "COMPLETED" && roomFinal.cleaning_status === "rework") ||
      (finalTask.status === "REWORK" && roomFinal.cleaning_status === "clean")
    ),
  ).toBeTruthy();

  await closeApi(apiB);
  await closeApi(api);
});

test("PII：任务响应与审计不含 Guest 身份/联系方式/预订数据", async () => {
  const api = await adminApi();

  // 105-108 的预订客人带可辨识 PII（gating 用例创建）
  const piiMarkers = [
    "门禁客人",
    "13900006666",
    "reservation_no",
    "agreed_total_amount",
  ];

  // 全部任务响应（列表 + 详情）不含 PII
  const list = await apiListTasks(api, { page_size: 100 });
  expect(list.total).toBeGreaterThan(0);
  for (const item of list.items) {
    const text = JSON.stringify(item);
    for (const marker of piiMarkers) {
      expect(text, `任务响应不得包含 PII 标记：${marker}`).not.toContain(marker);
    }
    const detail = await apiGetTask(api, item.id);
    for (const marker of piiMarkers) {
      expect(JSON.stringify(detail)).not.toContain(marker);
    }
  }

  // 审计 details 无 PII（housekeeping.create / start / pass 等）
  const auditResp = await api.ctx.get("/api/v1/audit-logs", {
    headers: api.headers,
    params: { action: "housekeeping.create", page_size: 100 },
  });
  expect(auditResp.status()).toBe(200);
  const auditItems = ((await auditResp.json()) as { items: { details: unknown }[] }).items;
  expect(auditItems.length).toBeGreaterThan(0);
  for (const entry of auditItems) {
    const text = JSON.stringify(entry.details);
    for (const marker of piiMarkers) {
      expect(text, "审计 details 不得包含 PII").not.toContain(marker);
    }
  }

  await closeApi(api);
});
