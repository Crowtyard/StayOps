import { requestJson, type Transport } from "./client";
import type {
  InitialStockCreate,
  InitialStockOut,
  InventoryBalanceOut,
  InventoryItemCreate,
  InventoryItemDetailOut,
  InventoryItemListParams,
  InventoryItemListRow,
  InventoryItemOut,
  InventoryItemUpdate,
  InventoryLocationOut,
  InventoryLocationUpdate,
  Page,
  PageParams,
  StockIssueCreate,
  StockIssueOut,
  StockMovementOut,
  StockReturnCreate,
  StockReturnOut,
  StocktakeCreate,
  StocktakeOut,
  StockTransferCreate,
  StockTransferOut,
} from "./types";

export interface InventoryApi {
  listItems(params?: InventoryItemListParams): Promise<Page<InventoryItemListRow>>;
  getItem(id: number | string): Promise<InventoryItemDetailOut>;
  createItem(payload: InventoryItemCreate): Promise<InventoryItemOut>;
  updateItem(id: number | string, payload: InventoryItemUpdate): Promise<InventoryItemOut>;
  setInitialStock(id: number | string, payload: InitialStockCreate): Promise<InitialStockOut>;
  listLocations(params?: PageParams & { is_active?: boolean }): Promise<Page<InventoryLocationOut>>;
  updateLocation(id: number | string, payload: InventoryLocationUpdate): Promise<InventoryLocationOut>;
  listBalances(params?: PageParams & { item_id?: number; location_id?: number }): Promise<Page<InventoryBalanceOut>>;
  listMovements(params?: PageParams & {
    item_id?: number;
    location_id?: number;
    movement_type?: string;
    reference_type?: string;
  }): Promise<Page<StockMovementOut>>;
  issue(payload: StockIssueCreate): Promise<StockIssueOut>;
  return(payload: StockReturnCreate): Promise<StockReturnOut>;
  transfer(payload: StockTransferCreate): Promise<StockTransferOut>;
  stocktake(payload: StocktakeCreate): Promise<StocktakeOut>;
}

export function createInventoryApi(transport: Transport): InventoryApi {
  return {
    listItems: (params) =>
      requestJson<Page<InventoryItemListRow>>(transport, "/inventory/items", {
        query: { ...params },
      }),
    getItem: (id) =>
      requestJson<InventoryItemDetailOut>(transport, `/inventory/items/${id}`),
    createItem: (payload) =>
      requestJson<InventoryItemOut>(transport, "/inventory/items", {
        method: "POST",
        body: payload,
      }),
    updateItem: (id, payload) =>
      requestJson<InventoryItemOut>(transport, `/inventory/items/${id}`, {
        method: "PATCH",
        body: payload,
      }),
    setInitialStock: (id, payload) =>
      requestJson<InitialStockOut>(transport, `/inventory/items/${id}/initial-stock`, {
        method: "POST",
        body: payload,
      }),
    listLocations: (params) =>
      requestJson<Page<InventoryLocationOut>>(transport, "/inventory/locations", {
        query: { ...params },
      }),
    updateLocation: (id, payload) =>
      requestJson<InventoryLocationOut>(transport, `/inventory/locations/${id}`, {
        method: "PATCH",
        body: payload,
      }),
    listBalances: (params) =>
      requestJson<Page<InventoryBalanceOut>>(transport, "/inventory/balances", {
        query: { ...params },
      }),
    listMovements: (params) =>
      requestJson<Page<StockMovementOut>>(transport, "/inventory/movements", {
        query: { ...params },
      }),
    issue: (payload) =>
      requestJson<StockIssueOut>(transport, "/inventory/issues", {
        method: "POST",
        body: payload,
      }),
    return: (payload) =>
      requestJson<StockReturnOut>(transport, "/inventory/returns", {
        method: "POST",
        body: payload,
      }),
    transfer: (payload) =>
      requestJson<StockTransferOut>(transport, "/inventory/transfers", {
        method: "POST",
        body: payload,
      }),
    stocktake: (payload) =>
      requestJson<StocktakeOut>(transport, "/inventory/stocktakes", {
        method: "POST",
        body: payload,
      }),
  };
}
