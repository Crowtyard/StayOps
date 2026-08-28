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

export type HousekeepingTaskSource = "CHECKOUT" | "MANUAL";

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
