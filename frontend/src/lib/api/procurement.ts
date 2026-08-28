import { requestJson, type Transport } from "./client";
import type {
  GoodsReceiptCreate,
  GoodsReceiptOut,
  Page,
  PageParams,
  PurchaseOrderCreate,
  PurchaseOrderOut,
  PurchaseOrderStatus,
  PurchaseRequestCreate,
  PurchaseRequestOut,
  PurchaseRequestStatus,
  SupplierCreate,
  SupplierOut,
  SupplierUpdate,
} from "./types";

export interface ProcurementApi {
  listSuppliers(params?: PageParams & { search?: string; is_active?: boolean }): Promise<Page<SupplierOut>>;
  getSupplier(id: number | string): Promise<SupplierOut>;
  createSupplier(payload: SupplierCreate): Promise<SupplierOut>;
  updateSupplier(id: number | string, payload: SupplierUpdate): Promise<SupplierOut>;
  listRequests(params?: PageParams & { status?: PurchaseRequestStatus; search?: string }): Promise<Page<PurchaseRequestOut>>;
  getRequest(id: number | string): Promise<PurchaseRequestOut>;
  createRequest(payload: PurchaseRequestCreate): Promise<PurchaseRequestOut>;
  submitRequest(id: number | string): Promise<PurchaseRequestOut>;
  approveRequest(id: number | string): Promise<PurchaseRequestOut>;
  rejectRequest(id: number | string): Promise<PurchaseRequestOut>;
  cancelRequest(id: number | string): Promise<PurchaseRequestOut>;
  listOrders(params?: PageParams & { status?: PurchaseOrderStatus; supplier_id?: number; search?: string }): Promise<Page<PurchaseOrderOut>>;
  getOrder(id: number | string): Promise<PurchaseOrderOut>;
  createOrder(payload: PurchaseOrderCreate): Promise<PurchaseOrderOut>;
  markOrdered(id: number | string): Promise<PurchaseOrderOut>;
  cancelOrder(id: number | string): Promise<PurchaseOrderOut>;
  receive(id: number | string, payload: GoodsReceiptCreate): Promise<GoodsReceiptOut>;
}

export function createProcurementApi(transport: Transport): ProcurementApi {
  return {
    listSuppliers: (params) =>
      requestJson<Page<SupplierOut>>(transport, "/procurement/suppliers", {
        query: { ...params },
      }),
    getSupplier: (id) =>
      requestJson<SupplierOut>(transport, `/procurement/suppliers/${id}`),
    createSupplier: (payload) =>
      requestJson<SupplierOut>(transport, "/procurement/suppliers", {
        method: "POST",
        body: payload,
      }),
    updateSupplier: (id, payload) =>
      requestJson<SupplierOut>(transport, `/procurement/suppliers/${id}`, {
        method: "PATCH",
        body: payload,
      }),
    listRequests: (params) =>
      requestJson<Page<PurchaseRequestOut>>(transport, "/procurement/requests", {
        query: { ...params },
      }),
    getRequest: (id) =>
      requestJson<PurchaseRequestOut>(transport, `/procurement/requests/${id}`),
    createRequest: (payload) =>
      requestJson<PurchaseRequestOut>(transport, "/procurement/requests", {
        method: "POST",
        body: payload,
      }),
    submitRequest: (id) =>
      requestJson<PurchaseRequestOut>(transport, `/procurement/requests/${id}/submit`, {
        method: "POST",
      }),
    approveRequest: (id) =>
      requestJson<PurchaseRequestOut>(transport, `/procurement/requests/${id}/approve`, {
        method: "POST",
      }),
    rejectRequest: (id) =>
      requestJson<PurchaseRequestOut>(transport, `/procurement/requests/${id}/reject`, {
        method: "POST",
      }),
    cancelRequest: (id) =>
      requestJson<PurchaseRequestOut>(transport, `/procurement/requests/${id}/cancel`, {
        method: "POST",
      }),
    listOrders: (params) =>
      requestJson<Page<PurchaseOrderOut>>(transport, "/procurement/orders", {
        query: { ...params },
      }),
    getOrder: (id) =>
      requestJson<PurchaseOrderOut>(transport, `/procurement/orders/${id}`),
    createOrder: (payload) =>
      requestJson<PurchaseOrderOut>(transport, "/procurement/orders", {
        method: "POST",
        body: payload,
      }),
    markOrdered: (id) =>
      requestJson<PurchaseOrderOut>(transport, `/procurement/orders/${id}/order`, {
        method: "POST",
      }),
    cancelOrder: (id) =>
      requestJson<PurchaseOrderOut>(transport, `/procurement/orders/${id}/cancel`, {
        method: "POST",
      }),
    receive: (id, payload) =>
      requestJson<GoodsReceiptOut>(transport, `/procurement/orders/${id}/receipts`, {
        method: "POST",
        body: payload,
      }),
  };
}
