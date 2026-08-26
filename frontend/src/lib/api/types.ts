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
