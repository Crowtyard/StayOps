/**
 * 与后端 OpenAPI（http://127.0.0.1:8000/openapi.json）对齐的类型定义。
 * 后端统一前缀 /api/v1，分页返回 {items,total,page,page_size}。
 */

export type OccupancyStatus =
  | "available"
  | "reserved"
  | "occupied"
  | "blocked"
  | "out_of_service";

export type CleaningStatus =
  | "clean"
  | "dirty"
  | "cleaning"
  | "inspection"
  | "rework";

/** Sprint 5 §4：Room 不可售来源（MANUAL = 人工锁房，MAINTENANCE = 维修） */
export type UnavailabilitySource = "MANUAL" | "MAINTENANCE";

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface PageParams {
  page?: number;
  page_size?: number;
}

export interface RoleBrief {
  id: number;
  name: string;
}

export interface RoomTypeBrief {
  id: number;
  name: string;
}

/** GET /api/v1/auth/me */
export interface MeOut {
  id: number;
  username: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  /**
   * D2 首次安装：为 true 时必须先修改初始密码才能使用其它功能。
   * 后端 `MeOut` 始终返回该字段；此处可选是为了兼容既有测试夹具
   * （缺失按 false 处理 = 不强制改密，与后端默认值一致）。
   */
  must_change_password?: boolean;
  created_at: string;
  updated_at: string;
  roles: RoleBrief[];
  permissions: string[];
}

/** 登录接口响应（POST /api/v1/auth/login） */
export interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in: number;
}

export interface UserOut {
  id: number;
  username: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  roles: RoleBrief[];
}

export interface UserCreate {
  username: string;
  password: string;
  display_name?: string | null;
  email?: string | null;
  phone?: string | null;
  is_active?: boolean;
}

export interface UserUpdate {
  username?: string | null;
  password?: string | null;
  display_name?: string | null;
  email?: string | null;
  phone?: string | null;
  is_active?: boolean | null;
}

export interface PermissionOut {
  id: number;
  code: string;
  name: string;
  description: string | null;
}

export interface RoleOut {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  permissions: PermissionOut[];
}

export interface RoleCreate {
  name: string;
  description?: string | null;
}

export interface RoleUpdate {
  name?: string | null;
  description?: string | null;
}

export interface RoomTypeOut {
  id: number;
  name: string;
  /** Decimal 以字符串序列化，如 "328.00" */
  base_price: string;
  capacity: number;
  description: string | null;
  created_at: string;
  updated_at: string;
  room_count: number;
}

export interface RoomTypeCreate {
  name: string;
  base_price: number | string;
  capacity: number;
  description?: string | null;
}

export interface RoomTypeUpdate {
  name?: string | null;
  base_price?: number | string | null;
  capacity?: number | null;
  description?: string | null;
}

export interface RoomOut {
  id: number;
  room_number: string;
  room_type_id: number;
  floor: number;
  occupancy_status: OccupancyStatus;
  cleaning_status: CleaningStatus;
  unavailability_source?: UnavailabilitySource | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  room_type: RoomTypeBrief | null;
}

export interface RoomListParams extends PageParams {
  occupancy_status?: OccupancyStatus;
  cleaning_status?: CleaningStatus;
  room_type_id?: number;
}

export interface RoomCreate {
  room_number: string;
  room_type_id: number;
  floor: number;
  occupancy_status?: OccupancyStatus;
  cleaning_status?: CleaningStatus;
  notes?: string | null;
}

export interface RoomUpdate {
  room_number?: string | null;
  room_type_id?: number | null;
  floor?: number | null;
  notes?: string | null;
}

export interface RoomStatusChange {
  occupancy_status?: OccupancyStatus | null;
  cleaning_status?: CleaningStatus | null;
}

export interface AuditLogOut {
  id: number;
  user_id: number | null;
  username: string | null;
  action: string;
  resource_type: string | null;
  resource_id: number | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}

export interface AuditLogListParams extends PageParams {
  action?: string;
  user_id?: number;
  resource_type?: string;
}

/* ------------------------------------------------------------------ */
/* Booking 域（S2-T1 后端契约，字段以实际 OpenAPI 为准）                */
/* ------------------------------------------------------------------ */

export type ReservationStatus =
  | "CONFIRMED"
  | "CANCELLED"
  | "NO_SHOW"
  | "CHECKED_IN"
  | "COMPLETED";

export type ReservationSource =
  | "DIRECT"
  | "PHONE"
  | "WECHAT"
  | "WALK_IN"
  | "OTA"
  | "CORPORATE"
  | "OTHER";

export type StayStatus = "ACTIVE" | "CHECKED_OUT";

/** Sprint 6 §10：换房原因（固定枚举，不建立自由字符串 reason）。 */
export type RoomMoveReason =
  | "MAINTENANCE"
  | "GUEST_REQUEST"
  | "ROOM_QUALITY"
  | "OPERATIONAL"
  | "UPGRADE"
  | "DOWNGRADE"
  | "OTHER";

/**
 * Sprint 6：在住房间分配记录（StayRoomAssignment）。
 * ended_at = null 表示当前 active assignment（后端 exclude_none 键缺失）。
 * reason = null（键缺失）表示 Check-in 初始分配（UI 显示「入住」）。
 */
export interface StayRoomAssignmentOut {
  id: number;
  stay_id: number;
  room_id: number;
  room_number?: string | null;
  started_at: string;
  ended_at?: string | null;
  reason?: RoomMoveReason | null;
  notes?: string | null;
  created_by?: number | null;
  created_at?: string | null;
}

export interface GuestOut {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface GuestCreate {
  name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}

export interface GuestUpdate {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}

export interface GuestListParams extends PageParams {
  search?: string;
}

/**
 * 预订响应。后端使用 response_model_exclude_none：
 * 被权限裁剪的字段与 null 字段以「键缺失」呈现（不在 JSON 中），
 * 因此除必填字段外一律可选。guest_name 仅 guest:read 时存在；
 * room_number / room_type_name / amount 等仅 reservation:read 时存在。
 */
export interface ReservationOut {
  id: number;
  reservation_no: string;
  guest_id: number;
  guest_name?: string | null;
  room_id: number;
  room_number?: string | null;
  room_type_id: number;
  room_type_name?: string | null;
  check_in_date: string;
  check_out_date: string;
  status: ReservationStatus;
  source: ReservationSource;
  external_reference?: string | null;
  /** Decimal 以字符串序列化，如 "428.00" */
  agreed_total_amount?: string | null;
  currency?: string | null;
  notes?: string | null;
  created_by?: number | null;
  updated_by?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  stay_id?: number | null;
}

export interface ReservationSummary {
  reservation_no: string;
  /** Sprint 6：原分配房（Check-in 后冻结；换房后与实际在住房不同）。 */
  room_id?: number | null;
  room_number?: string | null;
  check_in_date: string;
  check_out_date: string;
  status: ReservationStatus;
  source: ReservationSource;
  agreed_total_amount: string;
  currency: string;
}

export interface StayOut {
  id: number;
  stay_no: string;
  reservation_id: number;
  room_id: number;
  room_number?: string | null;
  status: StayStatus;
  actual_check_in_at: string;
  planned_check_out_date: string;
  actual_check_out_at?: string | null;
  created_by?: number | null;
  updated_by?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  guest_id?: number | null;
  guest_name?: string | null;
  reservation?: ReservationSummary | null;
  /** Sprint 6：在住房间分配历史（仅详情接口加载）。 */
  assignments?: StayRoomAssignmentOut[] | null;
}

/** POST /stays/{id}/room-move 请求（Sprint 6 §9/§10）。 */
export interface RoomMoveCreate {
  target_room_id: number;
  reason: RoomMoveReason;
  notes?: string | null;
}

/** room-move-options 单项：eligible=false 时 reason 为不可换入原因。 */
export interface RoomMoveOptionItem {
  room_id: number;
  room_number: string;
  room_type_id: number;
  room_type_name?: string | null;
  floor: number;
  eligible: boolean;
  reason?: string | null;
}

export interface RoomMoveOptionsOut {
  business_date: string;
  stay_id: number;
  stay_no: string;
  current_room_id: number;
  planned_check_out_date: string;
  items: RoomMoveOptionItem[];
}

export interface CheckInOut {
  reservation: ReservationOut;
  stay: StayOut;
}

export interface ReservationCreate {
  guest_id: number;
  room_id: number;
  room_type_id: number;
  check_in_date: string;
  check_out_date: string;
  source?: ReservationSource;
  external_reference?: string | null;
  agreed_total_amount: number | string;
  currency?: string;
  notes?: string | null;
}

/** PATCH 只提交发生变化的字段；status 不得经 PATCH 修改（后端 strict schema，携带即 422） */
export interface ReservationUpdate {
  guest_id?: number;
  room_id?: number;
  room_type_id?: number;
  check_in_date?: string;
  check_out_date?: string;
  source?: ReservationSource;
  external_reference?: string | null;
  agreed_total_amount?: number | string;
  currency?: string;
  notes?: string | null;
}

export interface ReservationListParams extends PageParams {
  status?: ReservationStatus;
  room_id?: number;
  guest_id?: number;
  room_type_id?: number;
  source?: ReservationSource;
  check_in_date?: string;
  check_out_date?: string;
  search?: string;
  /**
   * Sprint 4 日期窗口重叠查询（Room Diary 时间线批量拉取）：
   * 语义 = [check_in_date, check_out_date) 与 [overlap_from, overlap_to)
   * 有重叠（check_in < overlap_to AND check_out > overlap_from，紧邻不重叠）。
   * 必须成对提供，overlap_to 必须晚于 overlap_from（后端 422）。
   */
  overlap_from?: string;
  overlap_to?: string;
}

export interface StayListParams extends PageParams {
  status?: StayStatus;
  room_id?: number;
  planned_check_out_date?: string;
}

export interface AvailabilityItem {
  room_id: number;
  room_number: string;
  room_type_id: number;
  room_type_name?: string | null;
  floor: number;
  available: boolean;
  reason?: string | null;
}

export interface AvailabilityOut {
  business_date: string;
  check_in_date: string;
  check_out_date: string;
  total: number;
  available_count: number;
  items: AvailabilityItem[];
}

export interface AvailabilityParams {
  check_in_date: string;
  check_out_date: string;
  room_type_id?: number;
}

/* ------------------------------------------------------------------ */
/* Housekeeping 域（Sprint 3 后端契约，字段以实际 OpenAPI 为准）         */
/* ------------------------------------------------------------------ */

export type HousekeepingTaskStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "INSPECTION"
  | "REWORK"
  | "COMPLETED"
  | "CANCELLED";

export type HousekeepingTaskPriority = "NORMAL" | "URGENT";

export type HousekeepingTaskSource = "CHECKOUT" | "MANUAL" | "ROOM_MOVE";

/**
 * 保洁任务响应。后端使用 response_model_exclude_none：
 * null 字段（如未派单的 assignee_name、未开始的 started_at）以键缺失呈现。
 * 任务不含任何 Guest / Reservation 数据（Housekeeping 域无 PII）。
 */
export interface HousekeepingTaskOut {
  id: number;
  task_no: string;
  room_id: number;
  room_number: string;
  status: HousekeepingTaskStatus;
  priority: HousekeepingTaskPriority;
  source: HousekeepingTaskSource;
  assigned_to_user_id?: number | null;
  assignee_name?: string | null;
  notes?: string | null;
  started_at?: string | null;
  submitted_for_inspection_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  created_by?: number | null;
  updated_by?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** PATCH 只提交发生变化的字段；assigned_to_user_id 传 null = 取消派单；
 *  status 不得经 PATCH 修改（后端 strict schema，携带即 422） */
export interface HousekeepingTaskUpdate {
  priority?: HousekeepingTaskPriority;
  assigned_to_user_id?: number | null;
  notes?: string | null;
}

export interface HousekeepingTaskListParams extends PageParams {
  status?: HousekeepingTaskStatus;
  room_id?: number;
  assigned_to_user_id?: number;
  priority?: HousekeepingTaskPriority;
  source?: HousekeepingTaskSource;
  search?: string;
}

/** 可派单候选人（GET /housekeeping/assignees，housekeeping_task:write；
 *  仅员工身份信息，不含任何 Guest PII） */
export interface HousekeepingAssigneeOut {
  id: number;
  display_name: string;
  username: string;
}

/* ------------------------------------------------------------------ */
/* Maintenance 域（Sprint 5 后端契约，字段以实际 OpenAPI 为准）         */
/* ------------------------------------------------------------------ */

export type MaintenanceWorkOrderStatus =
  | "OPEN"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "RESOLVED"
  | "COMPLETED"
  | "CANCELLED";

export type MaintenanceCategory =
  | "ELECTRICAL"
  | "PLUMBING"
  | "HVAC"
  | "LOCK"
  | "BATHROOM"
  | "FURNITURE"
  | "APPLIANCE"
  | "NETWORK"
  | "FINISHING"
  | "OTHER";

export type MaintenanceSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type MaintenanceSource =
  | "MANUAL"
  | "FRONT_DESK"
  | "HOUSEKEEPING"
  | "PRE_OPENING";

/**
 * 维修工单响应。后端使用 response_model_exclude_none：
 * null 字段以键缺失呈现。工单不关联 Guest / Reservation / Stay，
 * 响应不含任何 Guest PII 与预订数据（Sprint 5 §30）。
 */
export interface MaintenanceWorkOrderOut {
  id: number;
  work_order_no: string;
  room_id: number;
  room_number: string;
  room_occupancy_status?: OccupancyStatus;
  room_cleaning_status?: CleaningStatus;
  category: MaintenanceCategory;
  severity: MaintenanceSeverity;
  status: MaintenanceWorkOrderStatus;
  source: MaintenanceSource;
  blocks_room: boolean;
  title: string;
  description?: string | null;
  reported_by_user_id?: number | null;
  reporter_name?: string | null;
  assigned_to_user_id?: number | null;
  assignee_name?: string | null;
  verified_by_user_id?: number | null;
  resolution_notes?: string | null;
  verification_notes?: string | null;
  started_at?: string | null;
  resolved_at?: string | null;
  verified_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  created_by?: number | null;
  updated_by?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface MaintenanceWorkOrderCreate {
  room_id: number;
  category: MaintenanceCategory;
  severity?: MaintenanceSeverity;
  blocks_room?: boolean;
  source?: MaintenanceSource;
  title: string;
  description?: string | null;
}

/** PATCH 只提交发生变化的字段；status / blocks_room 不得经 PATCH 修改（后端 strict，携带即 422） */
export interface MaintenanceWorkOrderUpdate {
  category?: MaintenanceCategory;
  severity?: MaintenanceSeverity;
  title?: string;
  description?: string | null;
}

export interface MaintenanceWorkOrderListParams extends PageParams {
  status?: MaintenanceWorkOrderStatus;
  room_id?: number;
  category?: MaintenanceCategory;
  severity?: MaintenanceSeverity;
  assigned_to?: number;
  blocks_room?: boolean;
  source?: MaintenanceSource;
  search?: string;
}

/** 可派单候选人（GET /maintenance/assignees，maintenance_order:write；
 *  持有 maintenance_order:work 的在职用户，不含任何 Guest PII） */
export interface MaintenanceAssigneeOut {
  id: number;
  display_name: string;
  username: string;
}

/* ------------------------------------------------------------------ */
/* Inventory 域（Sprint 7 后端契约，字段以实际 OpenAPI 为准）            */
/* ------------------------------------------------------------------ */

export type ItemCategory =
  | "GUEST_AMENITY"
  | "LINEN"
  | "CLEANING"
  | "FRONT_DESK"
  | "MAINTENANCE"
  | "OFFICE"
  | "OTHER";

export type MovementType =
  | "INITIAL"
  | "PURCHASE_RECEIPT"
  | "ISSUE"
  | "RETURN"
  | "TRANSFER_OUT"
  | "TRANSFER_IN"
  | "ADJUSTMENT_IN"
  | "ADJUSTMENT_OUT";

export type IssueDestinationType =
  | "HOUSEKEEPING"
  | "FRONT_DESK"
  | "MAINTENANCE"
  | "ROOM"
  | "OTHER";

/** 低库存状态（后端计算：total==0 -> OUT_OF_STOCK；total<=minimum -> LOW_STOCK） */
export type StockStatus = "NORMAL" | "LOW_STOCK" | "OUT_OF_STOCK";

export interface InventoryItemOut {
  id: number;
  item_code: string;
  name: string;
  category: ItemCategory;
  base_unit: string;
  specification?: string | null;
  minimum_stock: string;
  target_stock: string;
  is_consumable: boolean;
  is_active: boolean;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryItemCreate {
  item_code: string;
  name: string;
  category: ItemCategory;
  base_unit: string;
  specification?: string | null;
  minimum_stock?: number | string;
  target_stock?: number | string;
  is_consumable?: boolean;
  notes?: string | null;
}

/** PATCH：item_code 不可修改；只提交变更字段（后端 strict，空/未知字段 422） */
export interface InventoryItemUpdate {
  name?: string;
  category?: ItemCategory;
  base_unit?: string;
  specification?: string | null;
  minimum_stock?: number | string;
  target_stock?: number | string;
  is_consumable?: boolean;
  is_active?: boolean;
  notes?: string | null;
}

/** 列表行：聚合 total_stock + 低库存状态 + 建议补货量 */
export interface InventoryItemListRow {
  id: number;
  item_code: string;
  name: string;
  category: ItemCategory;
  base_unit: string;
  minimum_stock: string;
  target_stock: string;
  is_consumable: boolean;
  is_active: boolean;
  total_stock: string;
  stock_status: StockStatus;
  recommended_replenishment: string;
}

export interface InventoryItemListParams extends PageParams {
  search?: string;
  category?: ItemCategory;
  stock_status?: StockStatus;
  is_active?: boolean;
}

export interface InventoryBalanceOut {
  id: number;
  item_id: number;
  location_id: number;
  location_code?: string | null;
  location_name?: string | null;
  location_active: boolean;
  quantity: string;
  updated_at: string;
}

export interface StockMovementOut {
  id: number;
  movement_no: string;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  location_id: number;
  location_code?: string | null;
  location_name?: string | null;
  movement_type: MovementType;
  quantity: string;
  reference_type?: string | null;
  reference_id?: number | null;
  reason?: string | null;
  created_by_user_id?: number | null;
  operator_name?: string | null;
  created_at: string;
}

export interface InventoryItemDetailOut extends InventoryItemOut {
  total_stock: string;
  stock_status: StockStatus;
  recommended_replenishment: string;
  balances: InventoryBalanceOut[];
  recent_movements: StockMovementOut[];
}

export interface InventoryLocationOut {
  id: number;
  location_code: string;
  name: string;
  is_active: boolean;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryLocationUpdate {
  name?: string;
  is_active?: boolean;
  notes?: string | null;
}

export interface InitialStockCreate {
  location_id: number;
  quantity: number | string;
  reason?: string | null;
}

export interface InitialStockOut {
  id: number;
  movement_no: string;
  item_id: number;
  item_code: string;
  item_name: string;
  location_id: number;
  location_name: string;
  quantity: string;
  balance_quantity: string;
  reason?: string | null;
  created_at: string;
}

export interface IssueLineIn {
  item_id: number;
  quantity: number | string;
}

export interface StockIssueCreate {
  source_location_id: number;
  destination_type: IssueDestinationType;
  room_id?: number | null;
  notes?: string | null;
  lines: IssueLineIn[];
}

export interface StockIssueLineOut {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  base_unit?: string | null;
  quantity: string;
}

export interface StockIssueOut {
  id: number;
  issue_no: string;
  source_location_id: number;
  source_location_name?: string | null;
  destination_type: IssueDestinationType;
  room_id?: number | null;
  notes?: string | null;
  created_by_user_id?: number | null;
  operator_name?: string | null;
  created_at: string;
  lines: StockIssueLineOut[];
}

export interface StockReturnCreate {
  item_id: number;
  location_id: number;
  quantity: number | string;
  reason: string;
}

export interface StockReturnOut {
  id: number;
  movement_no: string;
  item_id: number;
  item_code: string;
  item_name: string;
  location_id: number;
  location_name: string;
  quantity: string;
  reason: string;
  created_at: string;
}

export interface TransferLineIn {
  item_id: number;
  quantity: number | string;
}

export interface StockTransferCreate {
  source_location_id: number;
  destination_location_id: number;
  reason?: string | null;
  lines: TransferLineIn[];
}

export interface StockTransferOut {
  source_location_id: number;
  source_location_name: string;
  destination_location_id: number;
  destination_location_name: string;
  reason?: string | null;
  created_by_user_id?: number | null;
  operator_name?: string | null;
  created_at: string;
  lines: StockIssueLineOut[];
  movement_ids: number[];
}

export interface StocktakeCreate {
  item_id: number;
  location_id: number;
  actual_quantity: number | string;
  reason: string;
}

export interface StocktakeOut {
  item_id: number;
  item_code: string;
  item_name: string;
  location_id: number;
  location_name: string;
  expected_quantity: string;
  actual_quantity: string;
  difference: string;
  movement_type?: MovementType | null;
  movement_id?: number | null;
  balance_quantity: string;
}

/* ------------------------------------------------------------------ */
/* Procurement 域（Sprint 7 后端契约，字段以实际 OpenAPI 为准）         */
/* ------------------------------------------------------------------ */

export type PurchaseRequestStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "APPROVED"
  | "ORDERED"
  | "REJECTED"
  | "CANCELLED";

export type PurchaseOrderStatus =
  | "DRAFT"
  | "ORDERED"
  | "PARTIALLY_RECEIVED"
  | "RECEIVED"
  | "CANCELLED";

export interface SupplierOut {
  id: number;
  supplier_code: string;
  name: string;
  contact_name?: string | null;
  phone?: string | null;
  wechat?: string | null;
  notes?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SupplierCreate {
  supplier_code: string;
  name: string;
  contact_name?: string | null;
  phone?: string | null;
  wechat?: string | null;
  notes?: string | null;
}

export interface SupplierUpdate {
  name?: string;
  contact_name?: string | null;
  phone?: string | null;
  wechat?: string | null;
  notes?: string | null;
  is_active?: boolean;
}

export interface PurchaseRequestLineOut {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  base_unit?: string | null;
  quantity: string;
  notes?: string | null;
}

export interface PurchaseRequestOut {
  id: number;
  request_no: string;
  status: PurchaseRequestStatus;
  requested_by_user_id?: number | null;
  requester_name?: string | null;
  approved_by_user_id?: number | null;
  approved_by_name?: string | null;
  submitted_at?: string | null;
  approved_at?: string | null;
  rejected_at?: string | null;
  cancelled_at?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  lines: PurchaseRequestLineOut[];
}

export interface PurchaseRequestLineIn {
  item_id: number;
  quantity: number | string;
  notes?: string | null;
}

export interface PurchaseRequestCreate {
  notes?: string | null;
  lines: PurchaseRequestLineIn[];
}

export interface PurchaseOrderLineOut {
  id: number;
  item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  base_unit?: string | null;
  ordered_quantity: string;
  received_quantity: string;
  remaining_quantity: string;
  unit_price?: string | null;
  line_total?: string | null;
}

export interface GoodsReceiptLineOut {
  id: number;
  purchase_order_line_id: number;
  item_id?: number | null;
  item_code?: string | null;
  item_name?: string | null;
  base_unit?: string | null;
  received_quantity: string;
}

export interface GoodsReceiptOut {
  id: number;
  receipt_no: string;
  purchase_order_id: number;
  inventory_location_id: number;
  inventory_location_name?: string | null;
  received_by_user_id?: number | null;
  receiver_name?: string | null;
  received_at?: string | null;
  notes?: string | null;
  created_at: string;
  lines: GoodsReceiptLineOut[];
}

export interface PurchaseOrderOut {
  id: number;
  order_no: string;
  supplier_id: number;
  supplier_code?: string | null;
  supplier_name?: string | null;
  purchase_request_id?: number | null;
  request_no?: string | null;
  status: PurchaseOrderStatus;
  ordered_at?: string | null;
  cancelled_at?: string | null;
  created_by_user_id?: number | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  order_total: string;
  lines: PurchaseOrderLineOut[];
  receipts: GoodsReceiptOut[];
}

export interface PurchaseOrderLineIn {
  item_id: number;
  ordered_quantity: number | string;
  unit_price?: number | string | null;
}

export interface PurchaseOrderCreate {
  supplier_id: number;
  purchase_request_id?: number | null;
  notes?: string | null;
  lines?: PurchaseOrderLineIn[] | null;
}

export interface GoodsReceiptLineIn {
  purchase_order_line_id: number;
  received_quantity: number | string;
}

export interface GoodsReceiptCreate {
  inventory_location_id: number;
  notes?: string | null;
  lines: GoodsReceiptLineIn[];
}

/* ------------------------------------------------------------------ */
/* Sprint 8 Analytics（read-only derived layer）                       */
/* ------------------------------------------------------------------ */

export interface AnalyticsPeriodOut {
  from: string;
  to: string;
  days: number;
}

export interface OnBooksHorizonOut {
  days: number;
  physical_room_nights: number;
  on_books_room_nights: number;
  occupancy_rate: number | null;
}

export interface OperationsOverviewMetricsOut {
  actual_occupied_room_nights: number;
  physical_room_nights: number;
  physical_occupancy_rate: number | null;
  completed_stays: number;
  average_length_of_stay: number | null;
  scheduled_arrivals: number;
  cancelled_arrivals: number;
  cancellation_rate: number | null;
  no_show_count: number;
  no_show_rate: number | null;
  average_booking_lead_days: number | null;
  room_move_count: number;
  moved_stay_count: number;
  room_move_rate: number | null;
  housekeeping_completed_tasks: number;
}

export interface OperationsSnapshotOut {
  active_stays: number;
  overdue_active_stays: number;
  housekeeping_backlog: number;
  active_maintenance: number;
  active_blocking_maintenance: number;
}

export interface ComparisonChangeOut {
  percent_change?: number | null;
  pp_delta?: number | null;
}

export interface OperationsOverviewComparisonOut {
  period: AnalyticsPeriodOut;
  metrics: OperationsOverviewMetricsOut;
  changes: Record<string, ComparisonChangeOut>;
}

export interface OperationsOverviewOut {
  business_date: string;
  period: AnalyticsPeriodOut;
  metrics: OperationsOverviewMetricsOut;
  snapshot: OperationsSnapshotOut;
  on_books: Record<"7d" | "14d" | "30d", OnBooksHorizonOut>;
  comparison: OperationsOverviewComparisonOut | null;
}

export interface LeadBucketOut {
  bucket: string;
  count: number;
}

export interface DailyOccupancyOut {
  business_date: string;
  occupied_room_nights: number;
  physical_room_nights: number;
  occupancy_rate: number | null;
}

export interface BookingsOut {
  business_date: string;
  period: AnalyticsPeriodOut;
  scheduled_arrivals: number;
  cancelled_arrivals: number;
  cancellation_rate: number | null;
  no_show_count: number;
  no_show_rate: number | null;
  average_booking_lead_days: number | null;
  booking_lead_distribution: LeadBucketOut[];
  completed_stays: number;
  average_length_of_stay: number | null;
  room_move_count: number;
  moved_stay_count: number;
  room_move_rate: number | null;
  daily: DailyOccupancyOut[];
}

export interface DailyHousekeepingOut {
  business_date: string;
  completed_tasks: number;
}

export interface HousekeepingOut {
  business_date: string;
  period: AnalyticsPeriodOut;
  housekeeping_completed_tasks: number;
  average_housekeeping_cycle_minutes: number | null;
  checkout_turnover_minutes: number | null;
  room_move_cleaning_tasks: number;
  housekeeping_backlog: number;
  daily: DailyHousekeepingOut[];
}

export interface MaintenanceCategoryCountOut {
  category: string;
  count: number;
}

export interface MaintenanceRoomCountOut {
  room_id: number;
  room_number: string;
  count: number;
}

export interface MaintenanceOut {
  business_date: string;
  period: AnalyticsPeriodOut;
  maintenance_created: number;
  maintenance_completed: number;
  active_maintenance: number;
  active_blocking_maintenance: number;
  mean_time_to_resolution_minutes: number | null;
  mean_verification_minutes: number | null;
  maintenance_by_category: MaintenanceCategoryCountOut[];
  maintenance_by_room: MaintenanceRoomCountOut[];
}

export interface RoomMoveReasonCountOut {
  reason: string;
  count: number;
}

export interface RoomMoveSourceRoomCountOut {
  room_id: number;
  room_number: string;
  count: number;
}

export interface RoomMovesOut {
  business_date: string;
  period: AnalyticsPeriodOut;
  room_move_count: number;
  moved_stay_count: number;
  room_move_rate: number | null;
  room_moves_by_reason: RoomMoveReasonCountOut[];
  room_moves_by_source_room: RoomMoveSourceRoomCountOut[];
}

export interface DailyContractedValueOut {
  business_date: string;
  contracted_room_value: string;
  priced_occupied_room_nights: number;
}

export interface BusinessRoomsOut {
  business_date: string;
  period: AnalyticsPeriodOut;
  contracted_room_value: string;
  priced_occupied_room_nights: number;
  unpriced_occupied_room_nights: number;
  contracted_adr: string | null;
  contracted_revpar: string | null;
  physical_room_nights: number;
  daily: DailyContractedValueOut[];
}

export interface InventoryItemAnalyticsOut {
  item_id: number;
  item_code: string;
  name: string;
  category: string;
  base_unit: string;
  stock_status: string;
  total_stock: string;
  is_active: boolean;
  issue_quantity: string;
  issue_quantity_per_occupied_room_night: number | null;
}

export interface BusinessInventoryOut {
  business_date: string;
  period: AnalyticsPeriodOut;
  current_low_stock_items: number;
  current_out_of_stock_items: number;
  occupied_room_nights: number;
  items: InventoryItemAnalyticsOut[];
}

export interface ReceivedValueBySupplierOut {
  supplier_id: number;
  supplier_code: string;
  supplier_name: string;
  received_value: string;
}

export interface ReceivedValueByItemOut {
  item_id: number;
  item_code: string;
  item_name: string;
  base_unit: string;
  received_value: string;
}

export interface DailyReceivedValueOut {
  business_date: string;
  received_purchase_value: string;
}

export interface BusinessProcurementOut {
  business_date: string;
  period: AnalyticsPeriodOut;
  purchase_requests_created: number;
  pending_purchase_requests: number;
  purchase_orders_created: number;
  pending_receipt_orders: number;
  partially_received_orders: number;
  received_purchase_value: string;
  unpriced_received_lines: number;
  received_value_by_supplier: ReceivedValueBySupplierOut[];
  received_value_by_item: ReceivedValueByItemOut[];
  daily: DailyReceivedValueOut[];
}

export interface ForecastDailyOut {
  business_date: string;
  on_books_room_nights: number;
  physical_room_nights: number;
  occupancy_rate: number | null;
}

export interface ForecastOut {
  business_date: string;
  physical_room_count: number;
  horizons: Record<"7d" | "14d" | "30d", OnBooksHorizonOut>;
  daily: ForecastDailyOut[];
}
