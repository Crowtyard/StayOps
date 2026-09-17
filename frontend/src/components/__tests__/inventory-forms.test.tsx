/**
 * 领用 / 调拨 / 盘点表单（Sprint 7 §54）测试：
 * - 校验：必填 / 数量 > 0 / 重复物资 / ROOM 必选房间 / 来源≠目的地
 * - 库存不足 409 detail 原文展示（后端最终权威）
 * - 成功后展示结果并回调
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { InventoryItemListRow, InventoryLocationOut, RoomOut } from "@/lib/api/types";
import IssueForm from "@/components/inventory/issue-form";
import TransferForm from "@/components/inventory/transfer-form";
import StocktakeForm from "@/components/inventory/stocktake-form";

const { issueMock, transferMock, stocktakeMock } = vi.hoisted(() => ({
  issueMock: vi.fn(),
  transferMock: vi.fn(),
  stocktakeMock: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      inventory: {
        issue: issueMock,
        transfer: transferMock,
        stocktake: stocktakeMock,
      },
    },
  };
});

function makeItem(overrides: Partial<InventoryItemListRow> = {}): InventoryItemListRow {
  return {
    id: 1,
    item_code: "AMEN-WATER-500",
    name: "矿泉水",
    category: "GUEST_AMENITY",
    base_unit: "瓶",
    minimum_stock: "20",
    target_stock: "100",
    is_consumable: true,
    is_active: true,
    total_stock: "10",
    stock_status: "LOW_STOCK",
    recommended_replenishment: "90",
    ...overrides,
  };
}

const ITEMS = [makeItem(), makeItem({ id: 2, item_code: "AMEN-SLP-001", name: "拖鞋", total_stock: "5" })];

const LOCATIONS: InventoryLocationOut[] = [
  { id: 1, location_code: "MAIN_STORAGE", name: "总仓", is_active: true, created_at: "x", updated_at: "x" },
  { id: 2, location_code: "FRONT_DESK", name: "前台", is_active: true, created_at: "x", updated_at: "x" },
];

const ROOMS: RoomOut[] = [
  {
    id: 10,
    room_number: "203",
    name: null,
    is_active: true,
    room_type_id: 1,
    floor: 2,
    occupancy_status: "available",
    cleaning_status: "clean",
    notes: null,
    created_at: "x",
    updated_at: "x",
    room_type: null,
  },
];

const noop = () => {};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("IssueForm 领用表单（Sprint 7 §11/§12/§54）", () => {
  it("未选来源地点 → 校验错误，不提交", async () => {
    render(
      <IssueForm open items={ITEMS} locations={LOCATIONS} rooms={ROOMS} onClose={noop} onSuccess={noop} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "确认领用" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请选择领用来源地点");
    expect(issueMock).not.toHaveBeenCalled();
  });

  it("未选物资 → 校验错误", async () => {
    render(
      <IssueForm open items={ITEMS} locations={LOCATIONS} rooms={ROOMS} onClose={noop} onSuccess={noop} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("领用来源地点"), "1");
    await userEvent.click(screen.getByRole("button", { name: "确认领用" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请至少选择一种物资并填写数量");
    expect(issueMock).not.toHaveBeenCalled();
  });

  it("ROOM 目的地必须选房间（422 由后端最终裁决）", async () => {
    render(
      <IssueForm open items={ITEMS} locations={LOCATIONS} rooms={ROOMS} onClose={noop} onSuccess={noop} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("领用来源地点"), "1");
    await userEvent.selectOptions(screen.getByLabelText("领用目的地"), "ROOM");
    await userEvent.selectOptions(screen.getByLabelText("领用物资"), "1");
    await userEvent.clear(screen.getByLabelText("领用数量"));
    await userEvent.type(screen.getByLabelText("领用数量"), "3");
    await userEvent.click(screen.getByRole("button", { name: "确认领用" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("领用目的地为房间时必须选择房间");
    expect(issueMock).not.toHaveBeenCalled();
  });

  it("库存不足 409：detail 原文展示（后端最终权威）", async () => {
    issueMock.mockRejectedValue(
      new ApiError("conflict", 409, "库存不足：AMEN-WATER-500 现有 10 瓶，领用 12 瓶"),
    );
    render(
      <IssueForm open items={ITEMS} locations={LOCATIONS} rooms={ROOMS} onClose={noop} onSuccess={noop} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("领用来源地点"), "1");
    await userEvent.selectOptions(screen.getByLabelText("领用物资"), "1");
    await userEvent.clear(screen.getByLabelText("领用数量"));
    await userEvent.type(screen.getByLabelText("领用数量"), "12");
    await userEvent.click(screen.getByRole("button", { name: "确认领用" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "库存不足：AMEN-WATER-500 现有 10 瓶，领用 12 瓶",
    );
    expect(issueMock).toHaveBeenCalledWith({
      source_location_id: 1,
      destination_type: "HOUSEKEEPING",
      room_id: null,
      lines: [{ item_id: 1, quantity: 12 }],
    });
  });

  it("成功后展示领用单号并回调", async () => {
    const onSuccess = vi.fn();
    issueMock.mockResolvedValue({ id: 1, issue_no: "SIS20260828-0001", lines: [] });
    render(
      <IssueForm open items={ITEMS} locations={LOCATIONS} rooms={ROOMS} onClose={noop} onSuccess={onSuccess} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("领用来源地点"), "1");
    await userEvent.selectOptions(screen.getByLabelText("领用物资"), "1");
    await userEvent.clear(screen.getByLabelText("领用数量"));
    await userEvent.type(screen.getByLabelText("领用数量"), "3");
    await userEvent.click(screen.getByRole("button", { name: "确认领用" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(await screen.findByRole("status")).toHaveTextContent("SIS20260828-0001");
  });
});

describe("TransferForm 调拨表单（Sprint 7 §16/§54）", () => {
  it("来源与目的地相同 → 本地校验错误", async () => {
    render(
      <TransferForm open items={ITEMS} locations={LOCATIONS} onClose={noop} onSuccess={noop} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("调拨来源地点"), "1");
    await userEvent.selectOptions(screen.getByLabelText("调拨目的地地点"), "1");
    await userEvent.click(screen.getByRole("button", { name: "确认调拨" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("调拨来源与目的地不能相同");
    expect(transferMock).not.toHaveBeenCalled();
  });

  it("库存不足 409 原文展示", async () => {
    transferMock.mockRejectedValue(
      new ApiError("conflict", 409, "库存不足：矿泉水 在 总仓 现有 10 瓶，调拨 15 瓶"),
    );
    render(
      <TransferForm open items={ITEMS} locations={LOCATIONS} onClose={noop} onSuccess={noop} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("调拨来源地点"), "1");
    await userEvent.selectOptions(screen.getByLabelText("调拨目的地地点"), "2");
    await userEvent.selectOptions(screen.getByLabelText("调拨物资"), "1");
    await userEvent.clear(screen.getByLabelText("调拨数量"));
    await userEvent.type(screen.getByLabelText("调拨数量"), "15");
    await userEvent.click(screen.getByRole("button", { name: "确认调拨" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "库存不足：矿泉水 在 总仓 现有 10 瓶，调拨 15 瓶",
    );
  });

  it("成功后提示酒店总库存不变并回调", async () => {
    const onSuccess = vi.fn();
    transferMock.mockResolvedValue({ movement_ids: [1, 2] });
    render(
      <TransferForm open items={ITEMS} locations={LOCATIONS} onClose={noop} onSuccess={onSuccess} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("调拨来源地点"), "1");
    await userEvent.selectOptions(screen.getByLabelText("调拨目的地地点"), "2");
    await userEvent.selectOptions(screen.getByLabelText("调拨物资"), "1");
    await userEvent.clear(screen.getByLabelText("调拨数量"));
    await userEvent.type(screen.getByLabelText("调拨数量"), "4");
    await userEvent.click(screen.getByRole("button", { name: "确认调拨" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(await screen.findByRole("status")).toHaveTextContent("酒店总库存不变");
  });
});

describe("StocktakeForm 盘点表单（Sprint 7 §18/§54）", () => {
  it("缺少盘点原因 → 校验错误（后端 422 最终权威）", async () => {
    render(
      <StocktakeForm open items={ITEMS} locations={LOCATIONS} onClose={noop} onSuccess={noop} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("盘点物资"), "1");
    await userEvent.selectOptions(screen.getByLabelText("盘点地点"), "1");
    await userEvent.type(screen.getByLabelText("实盘数量"), "3");
    await userEvent.click(screen.getByRole("button", { name: "提交盘点" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请填写盘点原因");
    expect(stocktakeMock).not.toHaveBeenCalled();
  });

  it("盘盈：展示 expected/actual/差异与盘盈调整", async () => {
    const onSuccess = vi.fn();
    stocktakeMock.mockResolvedValue({
      item_id: 1,
      item_code: "AMEN-WATER-500",
      item_name: "矿泉水",
      location_id: 1,
      location_name: "总仓",
      expected_quantity: "10",
      actual_quantity: "13",
      difference: "3",
      movement_type: "ADJUSTMENT_IN",
      movement_id: 9,
      balance_quantity: "13",
    });
    render(
      <StocktakeForm open items={ITEMS} locations={LOCATIONS} onClose={noop} onSuccess={onSuccess} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("盘点物资"), "1");
    await userEvent.selectOptions(screen.getByLabelText("盘点地点"), "1");
    await userEvent.type(screen.getByLabelText("实盘数量"), "13");
    await userEvent.type(screen.getByLabelText("盘点原因"), "月度盘点");
    await userEvent.click(screen.getByRole("button", { name: "提交盘点" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/盘盈调整/);
  });

  it("盘平（no-op）：提示无需调整", async () => {
    stocktakeMock.mockResolvedValue({
      item_id: 1,
      item_code: "AMEN-WATER-500",
      item_name: "矿泉水",
      location_id: 1,
      location_name: "总仓",
      expected_quantity: "10",
      actual_quantity: "10",
      difference: "0",
      balance_quantity: "10",
    });
    render(
      <StocktakeForm open items={ITEMS} locations={LOCATIONS} onClose={noop} onSuccess={noop} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("盘点物资"), "1");
    await userEvent.selectOptions(screen.getByLabelText("盘点地点"), "1");
    await userEvent.type(screen.getByLabelText("实盘数量"), "10");
    await userEvent.type(screen.getByLabelText("盘点原因"), "例行盘点");
    await userEvent.click(screen.getByRole("button", { name: "提交盘点" }));
    expect(await screen.findByRole("status")).toHaveTextContent("无需调整");
  });
});
