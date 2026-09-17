"""AI Schema Context（Sprint 9 §16）。

精简数据库结构上下文：覆盖 S1-S8 正式业务表的 AI 视图描述（表/重要字段/
枚举含义/关键关系），用于注入 System Prompt。

安全规则：
- 不包含 database credentials / system catalogs / internal secrets
- 不含 guests 表与任何 Guest PII 字段；不含 phone / email / password_hash 等
- 只描述 ai_* 只读视图（AI 能真正访问的集合），防止模型尝试访问基表
"""

# 中文描述，供模型理解各视图的业务含义
SCHEMA_CONTEXT = """数据库结构（只读 AI 视图，你只能查询以下视图；视图以外的表不可访问）：

【运营域】房间与预订（不含客人身份与金额）：
- ai_rooms(id, room_number, room_type_id, floor, occupancy_status, cleaning_status, unavailability_source, name, is_active)
  occupancy_status: available可用/reserved已预订/occupied在住/blocked人工锁房/out_of_service停用
  cleaning_status: clean干净/dirty待清扫/cleaning清扫中/inspection待验房/rework返工
  unavailability_source: NULL/MANUAL人工/MAINTENANCE维修
  name: 房间显示名称（可空）；is_active: 是否投入经营（false=停用房间，
  停用不释放 room_number，历史记录仍完整）。房间数量永远是 rooms 记录的计算
  结果（COUNT），不存在 room_count 字段。
  注意：occupancy_status 只表示**业务日期当天**的物理/运营状态，不代表
  "未来某天是否被预订"；某日房态请让用户到首页房态概览按日期查看。
- ai_room_types(id, name, base_price, capacity)
- ai_channels(id, code, name, category, enabled, is_system, sort_order)
  客源渠道主数据（可扩展，非硬编码枚举）：美团/携程/飞猪/直订/电话/微信/
  散客/协议客户/其他/历史来源 为系统预置；经营者可自建（抖音/小红书等）。
  category: OTA/OTA 平台; DIRECT直销; OFFLINE线下; CORPORATE协议客户; OTHER其他
  enabled=false 表示该渠道已停用（历史预订仍保留其渠道归属）。
- ai_reservations(id, reservation_no, room_id, room_type_id, check_in_date, check_out_date,
  status, source, source_channel_id, external_reference, created_at, updated_at)
  status: CONFIRMED已确认/CANCELLED已取消/NO_SHOW未到店/CHECKED_IN已入住/COMPLETED已完成
  **source_channel_id 是唯一来源渠道事实**（关联 ai_channels.id）；
  source 为 legacy 只读投影（旧枚举值），不要用它做渠道分析。
  日期区间为 [check_in_date, check_out_date)
- ai_stays(id, stay_no, reservation_id, room_id, status, actual_check_in_at,
  planned_check_out_date, actual_check_out_at, created_at, updated_at)
  status: ACTIVE在住/CHECKED_OUT已退房；room_id 为当前实际房间（换房后为新房）
- ai_stay_room_assignments(id, stay_id, room_id, started_at, ended_at, reason, created_at)
  reason 非空表示换房（MAINTENANCE/GUEST_REQUEST/ROOM_QUALITY/OPERATIONAL/UPGRADE/DOWNGRADE/OTHER）；
  ended_at 为 NULL 表示当前分配
- ai_housekeeping_tasks(id, task_no, room_id, status, priority, source,
  assigned_to_user_id, started_at, submitted_for_inspection_at, completed_at,
  cancelled_at, created_at, updated_at)
  status: PENDING待处理/IN_PROGRESS清扫中/INSPECTION待验房/REWORK返工/COMPLETED已完成/CANCELLED已取消
  source: CHECKOUT退房自动/MANUAL手动/ROOM_MOVE换房自动
- ai_maintenance_work_orders(id, work_order_no, room_id, category, severity, status,
  source, blocks_room, title, reported_by_user_id, assigned_to_user_id, started_at,
  resolved_at, verified_at, completed_at, cancelled_at, created_at, updated_at)
  status: OPEN/ASSIGNED/IN_PROGRESS/RESOLVED/COMPLETED/CANCELLED；
  blocks_room=true 且 status 为 OPEN/ASSIGNED/IN_PROGRESS/RESOLVED 时阻断客房销售
- ai_users(id, username, display_name, is_active)  # 员工（不含联系方式）

【经营域】库存与采购（不含供应商联系方式）：
- ai_inventory_items(id, item_code, name, category, base_unit, specification,
  minimum_stock, target_stock, is_consumable, is_active, created_at, updated_at)
  category: GUEST_AMENITY/LINEN/CLEANING/FRONT_DESK/MAINTENANCE/OFFICE/OTHER
- ai_inventory_locations(id, location_code, name, is_active, created_at, updated_at)
- ai_inventory_balances(id, item_id, location_id, quantity, updated_at)  # quantity >= 0
- ai_stock_movements(id, movement_no, item_id, location_id, movement_type, quantity,
  reference_type, reference_id, created_at)  # 永久账本，quantity 带符号：
  INITIAL>=0 / PURCHASE_RECEIPT>0 / RETURN>0 / TRANSFER_IN>0 / ADJUSTMENT_IN>0 /
  ISSUE<0 / TRANSFER_OUT<0 / ADJUSTMENT_OUT<0
- ai_stock_issues(id, issue_no, source_location_id, destination_type, room_id, created_at)
- ai_stock_issue_lines(id, issue_id, item_id, quantity)
- ai_suppliers(id, supplier_code, name, contact_name, is_active, created_at, updated_at)
- ai_purchase_requests(id, request_no, status, requested_by_user_id, submitted_at,
  approved_at, rejected_at, cancelled_at, created_at, updated_at)
  status: DRAFT/SUBMITTED/APPROVED/ORDERED/REJECTED/CANCELLED
- ai_purchase_request_lines(id, request_id, item_id, quantity)
- ai_purchase_orders(id, order_no, supplier_id, purchase_request_id, status, ordered_at,
  cancelled_at, created_at, updated_at)
  status: DRAFT/ORDERED/PARTIALLY_RECEIVED/RECEIVED/CANCELLED
- ai_purchase_order_lines(id, order_id, item_id, ordered_quantity, received_quantity, unit_price)
- ai_goods_receipts(id, receipt_no, purchase_order_id, inventory_location_id,
  received_by_user_id, received_at, created_at)  # 收货才是库存增加权威
- ai_goods_receipt_lines(id, receipt_id, purchase_order_line_id, received_quantity)

关键关系：
- reservations -> rooms(room_id)；stays -> reservations(reservation_id)、rooms(room_id)
- reservations -> channels(source_channel_id)  # 客源渠道归属（唯一事实源）
- stays 1:1 reservations；一个 Stay 可有多个 stay_room_assignments（换房历史）
- housekeeping_tasks / maintenance_work_orders -> rooms(room_id)
- stock_movements -> inventory_items(item_id)、inventory_locations(location_id)
- purchase_orders -> suppliers(supplier_id)、purchase_requests(purchase_request_id)
- goods_receipts -> purchase_orders(purchase_order_id)、inventory_locations
- 正式指标（入住率/ADR/RevPAR/取消率/ALOS/预测等）请用 get_analytics，不要自行计算
- 「哪个渠道订单最多 / 渠道收入（合同房费）最高 / 客源渠道占比」请用
  get_analytics(endpoint="channels")，不要自己 JOIN 计算
  （回答时请说明该金额是合同房费金额，非实际收款）

禁止访问：guests 表及任何客人身份/联系方式字段、供应商联系方式、用户联系方式、密码/凭据。
"""
