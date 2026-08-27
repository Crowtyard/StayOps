/**
 * S2-T3 PII 专项（HOUSEKEEPING，三层防护验证，REV-02 / REV-FINAL-04）：
 *
 * 数据构造（admin 直连真实后端）：房间 201 创建 Guest（含可辨识 PII）
 * → 预订 [today, today+2) → Check-in → 清洁状态置 dirty（现场 = occupied + dirty）。
 *
 * HOUSEKEEPING 断言：
 * 1. UI 层：Room 页可见 dirty / occupied / 当前有客；不出现 Guest 身份与
 *    Reservation 数据（name/phone/email/notes/reservation_no/amount）
 * 2. 网络响应层：页面加载期间全部 /api/bff/* 响应体不含上述 PII
 * 3. 直连 API：guests / reservations / stays / availability 全部 403
 */

import { expect, test } from "@playwright/test";
import {
  housekeepingPassword,
  housekeepingUsername,
  login,
  openRoomDetail,
} from "./helpers";
import { ensureTestUsers } from "./setup-users";
import {
  addDays,
  adminApi,
  apiCheckIn,
  apiCreateGuest,
  apiCreateReservation,
  apiGetRoomByNumber,
  apiSetRoomStatus,
  businessDate,
  closeApi,
} from "./booking-helpers";

const ROOM = "201";

const PII = {
  name: "王隐私",
  phone: "13800001111",
  email: "pii-leak-check@example.com",
  notes: "PII-NOTES-ONLY-X9",
  amount: "388.00",
};

const PII_FORBIDDEN = [PII.name, PII.phone, PII.email, PII.notes, PII.amount];

let guestId = 0;
let reservationId = 0;
let stayId = 0;

test.describe("PII 三层防护（HOUSEKEEPING）", () => {
  test.beforeAll(async () => {
    await ensureTestUsers();
    const api = await adminApi();
    const guest = await apiCreateGuest(api, {
      name: PII.name,
      phone: PII.phone,
      email: PII.email,
      notes: PII.notes,
    });
    guestId = guest.id;
    const room = await apiGetRoomByNumber(api, ROOM);
    const reservation = await apiCreateReservation(api, {
      guest_id: guestId,
      room_id: room.id,
      room_type_id: room.room_type_id,
      check_in_date: businessDate(),
      check_out_date: addDays(businessDate(), 2),
      agreed_total_amount: PII.amount,
    });
    reservationId = reservation.id;
    const checked = await apiCheckIn(api, reservationId);
    stayId = checked.stay.id;
    // 现场状态：occupied + dirty（HOUSEKEEPING 可见房态，但不可见身份）
    await apiSetRoomStatus(api, room.id, { cleaning_status: "dirty" });
    await closeApi(api);
  });

  test("PII：UI 层无身份数据（Room 页可见 dirty + occupied + 当前有客）", async ({
    page,
  }) => {
    await login(page, housekeepingUsername(), housekeepingPassword());

    // 导航无预订/在住入口
    await expect(page.getByRole("link", { name: "预订" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "在住" })).toHaveCount(0);

    await openRoomDetail(page, ROOM);

    // 可见：dirty + occupied + 当前有客（非身份摘要）
    await expect(
      page.locator("main").getByText("在住", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.locator("main").getByText("待清扫", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("当前有客")).toBeVisible();

    // 不可见：任何 Guest 身份 / 联系方式 / 预订数据
    for (const forbidden of PII_FORBIDDEN) {
      await expect(
        page.getByText(forbidden, { exact: true }),
        `Room 页不得出现 PII：${forbidden}`,
      ).toHaveCount(0);
    }
    await expect(page.getByText(/RSV\d{8}-\d{4,}/)).toHaveCount(0);
  });

  test("PII：网络响应层无身份数据（/api/bff 全部响应体断言）", async ({
    page,
  }) => {
    await login(page, housekeepingUsername(), housekeepingPassword());

    const bodies: Promise<string>[] = [];
    page.on("response", (res) => {
      if (res.url().includes("/api/bff/")) {
        bodies.push(res.text().catch(() => ""));
      }
    });

    await openRoomDetail(page, ROOM);
    await expect(page.getByText("当前有客")).toBeVisible();

    const texts = await Promise.all(bodies);
    expect(texts.length).toBeGreaterThan(0);
    for (const body of texts) {
      for (const forbidden of PII_FORBIDDEN) {
        expect(
          body,
          `网络响应不得包含 PII：${forbidden}`,
        ).not.toContain(forbidden);
      }
      expect(body).not.toMatch(/RSV\d{8}-\d{4,}/);
    }
  });

  test("PII：直连 API 全部 403（Booking 域无任何读取出口）", async ({ page }) => {
    await login(page, housekeepingUsername(), housekeepingPassword());

    const today = businessDate();
    const cases: { path: string; params?: Record<string, string> }[] = [
      { path: "/api/bff/guests" },
      { path: `/api/bff/guests/${guestId}` },
      { path: "/api/bff/reservations" },
      { path: `/api/bff/reservations/${reservationId}` },
      { path: "/api/bff/stays" },
      { path: `/api/bff/stays/${stayId}` },
      {
        path: "/api/bff/availability",
        params: { check_in_date: today, check_out_date: addDays(today, 2) },
      },
    ];
    for (const c of cases) {
      const resp = await page.request.get(c.path, { params: c.params });
      expect(
        resp.status(),
        `${c.path} 应为 403，实际 ${resp.status()}（${await resp.text()}）`,
      ).toBe(403);
    }
  });
});
