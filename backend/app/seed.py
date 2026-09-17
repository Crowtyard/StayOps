"""幂等种子脚本（开发环境 / 安装版首次初始化）。

用法（backend/ 目录下）：
    .venv\\Scripts\\python.exe -m app.seed

管理员 bootstrap 密码（D2 起）：
- 不再内置固定开发密码；必须由环境变量 `STAYOPS_ADMIN_PASSWORD` 提供。
- 开发/测试：conftest 与开发环境显式注入（安装版由 Desktop 首次启动生成随机
  高强度密码，仅注入 seed 进程，绝不出现在源码/日志/安装包中）。
- 缺失时直接报错（Fail Safe），不会静默使用任何默认值。

幂等策略（可重复执行，重复执行结果收敛且不报错）：
- permissions：按 code upsert（更新 name/description）
- roles：按 name upsert（更新 description）
- role_permissions：精确同步（删除多余映射、补齐缺失映射）；SUPER_ADMIN 动态=全部权限
- admin：不存在则创建（bcrypt 哈希，创建时校验）；已存在则不改密码（尊重「首次登录后可改密」），仅确保启用与 SUPER_ADMIN 角色
- room_types：按 name upsert（更新价格/容量/描述）
- rooms：按 room_number 缺失才创建（occupancy_status=available / cleaning_status=clean）；已存在仅修正房型/楼层，不覆盖状态

安全：不输出任何密码、哈希、Token。
"""

import os
from decimal import Decimal

from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import (
    Channel,
    ChannelCategory,
    CleaningStatus,
    InventoryLocation,
    OccupancyStatus,
    Permission,
    Role,
    RolePermission,
    Room,
    RoomType,
    User,
    UserRole,
)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# 管理员 bootstrap 账号（密码由 STAYOPS_ADMIN_PASSWORD 提供，见模块 docstring）
ADMIN_USERNAME = "admin"


def admin_password() -> str:
    """bootstrap 管理员密码：仅来自环境变量（开发/测试/安装版各自注入）。"""
    password = os.environ.get("STAYOPS_ADMIN_PASSWORD")
    if not password:
        raise RuntimeError(
            "STAYOPS_ADMIN_PASSWORD 未设置：seed 需要 bootstrap 管理员密码（"
            "测试由 conftest 注入；开发环境请在 backend/.env 或 shell 中设置；"
            "安装版由 Desktop 首次启动生成）。"
        )
    return password

# 权限集：模块 × 操作（task 要求至少覆盖 user/role/room/room_type/audit 的 read/write/delete；
# 额外增加 room:status_cleaning / room:status_maintenance 两个细粒度权限，
# 以支持 HOUSEKEEPING / MAINTENANCE 的「仅变更单一房态」职责）
PERMISSIONS: dict[str, tuple[str, str]] = {
    "user:read": ("查看用户", "查看用户列表与详情"),
    "user:write": ("编辑用户", "创建与更新用户"),
    "user:delete": ("删除用户", "删除用户"),
    "role:read": ("查看角色", "查看角色与角色权限"),
    "role:write": ("编辑角色", "创建与更新角色、设置角色权限"),
    "role:delete": ("删除角色", "删除角色"),
    "room:read": ("查看房间", "查看房间列表与详情"),
    # room:write = **日常运营房态操作**（不承担房间主数据管理）：
    #   仅用于 POST /rooms/{id}/status（占用/清洁维度状态机变更）与
    #   deps.authorize_status_change 的"可改任意维度"判定。
    #   房间主数据（房号/房型/楼层/名称/备注/启用停用/物理库存归属）
    #   一律由 room:inventory_manage 守卫 —— 见 alpha.9.6 QA DEF-1 决策。
    "room:write": ("房间房态操作", "变更房间占用/清洁状态（房态状态机操作）"),
    "room:inventory_manage": (
        "管理房间库存",
        "新增/编辑/停用/启用/删除房间主数据（房号、房型、楼层、名称、备注、经营启停）",
    ),
    "room:delete": ("删除房间", "删除房间（仅限从未被业务记录引用的房间）"),
    "room:status_cleaning": ("清洁状态变更", "变更房间清洁状态（cleaning_status）"),
    "room:status_maintenance": ("置为维修停用", "将房间占用状态置为 out_of_service（维修/停用）"),
    "room_type:read": ("查看房型", "查看房型列表与详情"),
    "room_type:write": ("编辑房型", "创建与更新房型"),
    "room_type:delete": ("删除房型", "删除房型"),
    # alpha.9.6 F3：客源渠道主数据权限（用 permission 判断，不用角色名）
    #   channel:read  前台创建/编辑 Reservation 时读取并选择来源渠道
    #   channel:write 渠道主数据管理（新增/改名/停用/删除）
    #   注意：channel:read 不授予任何渠道收入/ADR 经营分析能力 ——
    #   渠道经营分析属 analytics:business_read 域。
    "channel:read": ("查看渠道", "查看客源渠道列表（用于预订选择来源渠道）"),
    "channel:write": ("管理渠道", "新增、编辑、停用、删除客源渠道"),
    "audit:read": ("查看审计日志", "查看审计日志"),
    "audit:write": ("写入审计日志", "写入审计日志"),
    "audit:delete": ("删除审计日志", "删除审计日志"),
    # Sprint 2（S2-T1）：Booking 域权限
    "guest:read": ("查看客人", "查看客人档案与联系方式"),
    "guest:write": ("编辑客人", "创建与更新客人档案"),
    "reservation:read": ("查看预订", "查看预订列表与详情"),
    "reservation:write": ("编辑预订", "创建与更新预订"),
    "reservation:cancel": ("取消预订", "取消 CONFIRMED 状态的预订"),
    "reservation:no_show": ("标记未到店", "将 CONFIRMED 预订标记为未到店"),
    "stay:read": ("查看入住", "查看入住列表与详情"),
    "stay:check_in": ("办理入住", "办理预订入住并创建 Stay"),
    "stay:check_out": ("办理退房", "办理退房"),
    # Sprint 6：Room Move（§18：SUPER_ADMIN / MANAGER / FRONT_DESK）
    "stay:room_move": ("办理换房", "为在住记录办理换房"),
    # Sprint 3：Housekeeping 域权限
    "housekeeping_task:read": ("查看保洁任务", "查看保洁任务列表与详情"),
    "housekeeping_task:write": ("编辑保洁任务", "手动创建保洁任务、派单与修改"),
    "housekeeping_task:work": ("执行保洁任务", "开始清扫与提交验房"),
    "housekeeping_task:inspect": ("验收保洁任务", "验房通过或返工"),
    "housekeeping_task:cancel": ("取消保洁任务", "取消进行中的保洁任务"),
    # Sprint 5：Maintenance 域权限（用 permission 判断，不用角色名）
    "maintenance_order:read": ("查看维修工单", "查看维修工单列表与详情"),
    "maintenance_order:write": ("编辑维修工单", "创建维修工单、编辑与派单"),
    "maintenance_order:work": ("执行维修工单", "开始维修与提交解决"),
    "maintenance_order:verify": ("验收维修工单", "验收通过或返工"),
    "maintenance_order:cancel": ("取消维修工单", "取消进行中的维修工单"),
    # Sprint 7：Inventory 域权限（§35/§36，用 permission 判断，不用角色名）
    "inventory:read": ("查看库存", "查看物资、地点、余额与流水"),
    "inventory:issue": ("领用与归还", "办理物资领用与归还"),
    "inventory:adjust": ("盘点调整", "办理库存盘点与差异调整"),
    "inventory:transfer": ("库存调拨", "办理库间调拨"),
    "inventory:item_manage": ("管理库存物资", "创建与编辑物资档案、库存地点与期初库存"),
    # Sprint 7：Procurement 域权限
    "procurement:read": ("查看采购", "查看供应商、采购申请与采购订单"),
    "procurement:request": ("发起采购申请", "创建、提交与取消采购申请"),
    "procurement:approve": ("审批采购申请", "批准或驳回采购申请"),
    "procurement:order": ("创建采购订单", "创建采购订单、下达与取消"),
    "procurement:receive": ("办理收货", "创建收货单并入库"),
    "procurement:supplier_manage": ("管理供应商", "创建与编辑供应商档案"),
    # Sprint 8：Analytics 域权限（§34 矩阵，用 permission 判断，禁止硬编码角色名）
    #   operations_read：Occupancy / Bookings / Stay / Housekeeping / Maintenance /
    #                    Room Move / Forecast（§35）
    #   business_read：Contracted Room Value / Contracted ADR / Contracted RevPAR /
    #                  Inventory Analytics / Procurement Analytics / Supplier value
    "analytics:operations_read": ("查看运营分析", "查看经营分析中的运营指标（占用/预订/保洁/维修/换房/预测）"),
    "analytics:business_read": ("查看经营分析", "查看经营分析中的经营指标（合同房费/库存/采购）"),
    # Sprint 9：AI Manager 域权限（用 permission 判断，禁止硬编码角色名）
    #   ai_manager:use    可以打开 AI Manager（可见数据仍受当前用户既有
    #                     analytics:operations_read / business_read 域限制，§22/§23）
    #   ai_manager:manage 管理 AI 设置（/settings/ai：保存/更新/删除 Key、测试连接）
    "ai_manager:use": ("使用 AI 店长", "打开 AI Manager 并发送经营/运营问题"),
    "ai_manager:manage": ("管理 AI 设置", "配置 DeepSeek API Key 与模型"),
}

ROLES: dict[str, str] = {
    "SUPER_ADMIN": "超级管理员：拥有全部权限",
    "MANAGER": "店长/经理：用户、房间、房型、审计读写，角色只读",
    "FRONT_DESK": "前台：房间读写，房型、审计只读",
    "HOUSEKEEPING": "保洁：房间只读，房态可变更清洁中",
    "MAINTENANCE": "维修：房间只读，房态可变更维修中",
    "FINANCE": "财务：审计、房间只读",
}

# 角色 -> 权限码列表；SUPER_ADMIN 特殊处理为「全部权限」
# Sprint 2（S2-T1）：MANAGER / FRONT_DESK 获得全部 9 个 Booking 权限；
# HOUSEKEEPING / MAINTENANCE / FINANCE 不获得 Booking 权限（总纲 §8 角色矩阵）
BOOKING_PERMISSIONS: list[str] = [
    "guest:read",
    "guest:write",
    "reservation:read",
    "reservation:write",
    "reservation:cancel",
    "reservation:no_show",
    "stay:read",
    "stay:check_in",
    "stay:check_out",
]

# Sprint 6 §18：stay:room_move 角色矩阵
#   SUPER_ADMIN ✓ / MANAGER ✓ / FRONT_DESK ✓
#   HOUSEKEEPING / MAINTENANCE / FINANCE ×
ROOM_MOVE_PERMISSIONS: list[str] = ["stay:room_move"]

# alpha.9.6 F3：渠道主数据角色矩阵（用途判断，禁止硬编码角色名）
#   channel:read   MANAGER ✓ / FRONT_DESK ✓ —— 前台必须能在创建 Reservation 时
#                  选择来源渠道（否则无法录入订单来源）
#   channel:write  MANAGER ✓ —— 仅店长/经理可管理渠道主数据
#                  FRONT_DESK ×：不得停用/删改渠道配置
#   HOUSEKEEPING / MAINTENANCE / FINANCE 均不获得渠道权限
#   （FINANCE 的渠道【经营分析】走既有 analytics:business_read，与 channel:* 无关）
CHANNEL_READ: list[str] = ["channel:read"]
CHANNEL_WRITE: list[str] = ["channel:read", "channel:write"]

# Sprint 3：Housekeeping 域角色矩阵（SUPER_ADMIN 动态全部）
#   MANAGER     = read + write + work + inspect + cancel
#   FRONT_DESK  = read + write
#   HOUSEKEEPING= read + work + inspect
#   MAINTENANCE / FINANCE = 无
HK_TASK_ALL: list[str] = [
    "housekeeping_task:read",
    "housekeeping_task:write",
    "housekeeping_task:work",
    "housekeeping_task:inspect",
    "housekeeping_task:cancel",
]

# Sprint 5：Maintenance 域角色矩阵（SUPER_ADMIN 动态全部，Sprint 5 §31）
#   MANAGER     = read + write + work + verify + cancel
#   FRONT_DESK  = read + write
#   HOUSEKEEPING= read + write
#   MAINTENANCE = read + work
#   FINANCE     = 无
MWO_ALL: list[str] = [
    "maintenance_order:read",
    "maintenance_order:write",
    "maintenance_order:work",
    "maintenance_order:verify",
    "maintenance_order:cancel",
]

# Sprint 7 §36：Inventory / Procurement 域角色矩阵（SUPER_ADMIN 动态全部）
#   SUPER_ADMIN / MANAGER = 全部 11 个新权限
#   FRONT_DESK  = inventory:read + inventory:issue
#               + procurement:read + procurement:request + procurement:receive
#   HOUSEKEEPING= inventory:read + inventory:issue + procurement:request
#   MAINTENANCE = inventory:read + inventory:issue + procurement:request
#   FINANCE     = inventory:read + procurement:read
# inventory:adjust / inventory:transfer / inventory:item_manage /
# procurement:approve / procurement:order / procurement:supplier_manage
#   仅 SUPER_ADMIN / MANAGER（§36）
INVENTORY_PRO: list[str] = [
    "inventory:read",
    "inventory:issue",
    "inventory:adjust",
    "inventory:transfer",
    "inventory:item_manage",
    "procurement:read",
    "procurement:request",
    "procurement:approve",
    "procurement:order",
    "procurement:receive",
    "procurement:supplier_manage",
]

# Sprint 8 §34：Analytics 域角色矩阵（用 permission 判断，禁止硬编码角色名）
#   SUPER_ADMIN / MANAGER          = operations ✓ + business ✓
#   FRONT_DESK                     = operations ✓ + business ×
#   HOUSEKEEPING / MAINTENANCE     = × + ×
#   FINANCE                        = operations × + business ✓
ANALYTICS_OPERATIONS: list[str] = ["analytics:operations_read"]
ANALYTICS_BUSINESS: list[str] = ["analytics:business_read"]

# Sprint 9 §22：AI Manager 角色矩阵（用 permission 判断，禁止硬编码角色名）
#   ai_manager:use     SUPER_ADMIN / MANAGER / FRONT_DESK / FINANCE ✓
#                      HOUSEKEEPING / MAINTENANCE ×
#   ai_manager:manage  SUPER_ADMIN / MANAGER ✓（其余 ×）
AI_USE: list[str] = ["ai_manager:use"]
AI_MANAGE: list[str] = ["ai_manager:manage"]

# alpha.9.6 QA DEF-1（RBAC privilege expansion）修复：房间主数据权限收敛
#   背景：alpha.9.6 新增 POST /rooms/{id}/disable|enable 后，若继续用
#   room:write 守卫，则 FRONT_DESK（既有 room:write）获得"新增/编辑/停用/启用
#   房间主数据"的能力 —— 与 Field Trial PRD「不要让普通低权限用户随意修改
#   基础房间库存」冲突。独立 QA 已用真实 HTTP 复现（POST=201 / PATCH=200 /
#   enable=200）。
#   决策：房间主数据管理（create / update / disable / enable / delete）统一纳入
#   room:inventory_manage 保护区；room:write 仅保留日常房态操作语义。
#   DELETE /rooms/{id} 额外保留 room:delete（仓库既有决策：该码不授予任何常规
#   角色）→ 两码 AND，因此 FRONT_DESK 与 MANAGER 均无法删除房间，
#   不产生任何权限扩张。
#   SUPER_ADMIN 经 seed 动态获得全部权限码，无需显式列出。
#   授权唯一来源 = seed.py（migration 不写 permissions / role_permissions）。
ROOM_INVENTORY_MANAGE: list[str] = ["room:inventory_manage"]

ROLE_PERMISSIONS: dict[str, list[str]] = {
    "SUPER_ADMIN": [],
    "MANAGER": [
        "user:read",
        "user:write",
        "role:read",
        "room:read",
        "room:write",
        *ROOM_INVENTORY_MANAGE,
        "room_type:read",
        "room_type:write",
        *CHANNEL_WRITE,
        "audit:read",
        "audit:write",
        *BOOKING_PERMISSIONS,
        *ROOM_MOVE_PERMISSIONS,
        *HK_TASK_ALL,
        *MWO_ALL,
        *INVENTORY_PRO,
        *ANALYTICS_OPERATIONS,
        *ANALYTICS_BUSINESS,
        *AI_USE,
        *AI_MANAGE,
    ],
    "FRONT_DESK": [
        "room:read",
        # 仅房态操作（POST /rooms/{id}/status）；无 room:inventory_manage
        "room:write",
        "room_type:read",
        *CHANNEL_READ,
        "audit:read",
        *BOOKING_PERMISSIONS,
        *ROOM_MOVE_PERMISSIONS,
        "housekeeping_task:read",
        "housekeeping_task:write",
        "maintenance_order:read",
        "maintenance_order:write",
        "inventory:read",
        "inventory:issue",
        "procurement:read",
        "procurement:request",
        "procurement:receive",
        *ANALYTICS_OPERATIONS,
        *AI_USE,
    ],
    "HOUSEKEEPING": [
        "room:read",
        "room:status_cleaning",
        "housekeeping_task:read",
        "housekeeping_task:work",
        "housekeeping_task:inspect",
        "maintenance_order:read",
        "maintenance_order:write",
        "inventory:read",
        "inventory:issue",
        "procurement:request",
    ],
    "MAINTENANCE": [
        "room:read",
        "room:status_maintenance",
        "maintenance_order:read",
        "maintenance_order:work",
        "inventory:read",
        "inventory:issue",
        "procurement:request",
    ],
    "FINANCE": [
        "audit:read",
        "room:read",
        "inventory:read",
        "procurement:read",
        *ANALYTICS_BUSINESS,
        *AI_USE,
    ],
}

# 房型：name -> (base_price, capacity, description)
ROOM_TYPES: list[tuple[str, Decimal, int, str]] = [
    ("标准大床房", Decimal("328.00"), 2, "1.8m 大床，城市景观"),
    ("标准双床房", Decimal("298.00"), 2, "1.2m 双床"),
    ("豪华大床房", Decimal("428.00"), 2, "1.8m 大床，高层城市景观"),
    ("豪华双床房", Decimal("398.00"), 2, "1.35m 双床"),
    ("豪华套房", Decimal("688.00"), 4, "一室一厅，含会客区"),
    ("行政套房", Decimal("888.00"), 4, "行政楼层，一室一厅，含迷你吧"),
]

# 28 个测试房间：room_number -> (房型名, 楼层)
ROOMS: list[tuple[str, str, int]] = [
    ("101", "标准大床房", 1),
    ("102", "标准大床房", 1),
    ("103", "标准大床房", 1),
    ("104", "标准大床房", 1),
    ("105", "标准双床房", 1),
    ("106", "标准双床房", 1),
    ("107", "标准双床房", 1),
    ("108", "标准双床房", 1),
    ("109", "豪华大床房", 1),
    ("110", "豪华大床房", 1),
    ("201", "豪华大床房", 2),
    ("202", "豪华大床房", 2),
    ("203", "豪华大床房", 2),
    ("204", "豪华大床房", 2),
    ("205", "豪华双床房", 2),
    ("206", "豪华双床房", 2),
    ("207", "豪华双床房", 2),
    ("208", "豪华双床房", 2),
    ("209", "豪华套房", 2),
    ("210", "豪华套房", 2),
    ("301", "豪华套房", 3),
    ("302", "豪华套房", 3),
    ("303", "豪华套房", 3),
    ("304", "行政套房", 3),
    ("305", "行政套房", 3),
    ("306", "行政套房", 3),
    ("307", "豪华大床房", 3),
    ("308", "豪华大床房", 3),
]

assert len(ROOMS) == 28, "测试房间必须为 28 个"
assert 4 <= len(ROOM_TYPES) <= 6, "房型数量应为 4-6 种"


def seed_permissions(db: Session) -> dict[str, Permission]:
    by_code: dict[str, Permission] = {}
    for code, (name, description) in PERMISSIONS.items():
        perm = db.scalar(select(Permission).where(Permission.code == code))
        if perm is None:
            perm = Permission(code=code, name=name, description=description)
            db.add(perm)
        else:
            perm.name = name
            perm.description = description
        by_code[code] = perm
    db.flush()
    return by_code


def _sync_role_permissions(
    db: Session, role: Role, desired_ids: set[int]
) -> None:
    existing_ids = set(
        db.scalars(
            select(RolePermission.permission_id).where(
                RolePermission.role_id == role.id
            )
        )
    )
    for pid in desired_ids - existing_ids:
        db.add(RolePermission(role_id=role.id, permission_id=pid))
    for pid in existing_ids - desired_ids:
        row = db.get(RolePermission, (role.id, pid))
        if row is not None:
            db.delete(row)


def seed_roles(db: Session, perms: dict[str, Permission]) -> dict[str, Role]:
    all_ids = {p.id for p in db.scalars(select(Permission))}
    by_name: dict[str, Role] = {}
    for name, description in ROLES.items():
        role = db.scalar(select(Role).where(Role.name == name))
        if role is None:
            role = Role(name=name, description=description)
            db.add(role)
        else:
            role.description = description
        db.flush()
        if name == "SUPER_ADMIN":
            desired = set(all_ids)
        else:
            desired = {perms[code].id for code in ROLE_PERMISSIONS[name]}
        _sync_role_permissions(db, role, desired)
        by_name[name] = role
    return by_name


def seed_admin(db: Session, super_admin: Role) -> None:
    user = db.scalar(select(User).where(User.username == ADMIN_USERNAME))
    if user is None:
        password = admin_password()
        # 安装版首次 seed（bootstrap 凭据）→ 强制首次登录改密；开发/测试不变
        bootstrap = os.environ.get("STAYOPS_ADMIN_BOOTSTRAP") == "1"
        user = User(
            username=ADMIN_USERNAME,
            password_hash=pwd_context.hash(password),
            display_name="系统管理员",
            is_active=True,
            must_change_password=bootstrap,
        )
        db.add(user)
        db.flush()
        # 创建时自检：哈希必须为 bcrypt 且可验证
        if not pwd_context.verify(password, user.password_hash):
            raise RuntimeError("admin 密码哈希自检失败")
    elif not user.is_active:
        user.is_active = True
    if db.get(UserRole, (user.id, super_admin.id)) is None:
        db.add(UserRole(user_id=user.id, role_id=super_admin.id))


def seed_room_types(db: Session) -> dict[str, RoomType]:
    by_name: dict[str, RoomType] = {}
    for name, price, capacity, description in ROOM_TYPES:
        rt = db.scalar(select(RoomType).where(RoomType.name == name))
        if rt is None:
            rt = RoomType(
                name=name,
                base_price=price,
                capacity=capacity,
                description=description,
            )
            db.add(rt)
        else:
            rt.base_price = price
            rt.capacity = capacity
            rt.description = description
        by_name[name] = rt
    db.flush()
    return by_name


def seed_rooms(db: Session, types_by_name: dict[str, RoomType]) -> None:
    for room_number, type_name, floor in ROOMS:
        room = db.scalar(
            select(Room).where(Room.room_number == room_number)
        )
        rt = types_by_name[type_name]
        if room is None:
            room = Room(
                room_number=room_number,
                room_type_id=rt.id,
                floor=floor,
                occupancy_status=OccupancyStatus.available,
                cleaning_status=CleaningStatus.clean,
            )
            db.add(room)
        else:
            # 不覆盖状态（运营可能已变更），仅修正房型与楼层
            room.room_type_id = rt.id
            room.floor = floor


# Sprint 7 §6：库存地点（location_code -> name），种子必须幂等
INVENTORY_LOCATIONS: list[tuple[str, str]] = [
    ("MAIN_STORAGE", "总仓"),
    ("FRONT_DESK", "前台"),
    ("HOUSEKEEPING", "保洁间"),
    ("MAINTENANCE", "维修间"),
]


def seed_inventory_locations(db: Session) -> None:
    for location_code, name in INVENTORY_LOCATIONS:
        location = db.scalar(
            select(InventoryLocation).where(
                InventoryLocation.location_code == location_code
            )
        )
        if location is None:
            db.add(
                InventoryLocation(
                    location_code=location_code,
                    name=name,
                    is_active=True,
                )
            )
        else:
            location.name = name


def _count(db: Session, model: type) -> int:
    return len(db.scalars(select(model)).all())


# ---------------------------------------------------------------------------
# alpha.9.6 F3：客源渠道主数据（幂等 upsert；语义与渠道管理 UI 一致）
# ---------------------------------------------------------------------------
# code 稳定不可变（迁移映射 / 外部引用依赖它）；name 为经营者可见名称。
# 系统预置渠道：美团 / 携程 / 飞猪 为 OTA 主渠道；直订 / 电话 / 微信 / 散客 /
# 协议客户 覆盖原有 legacy source 语义；「其他」为默认兜底渠道（可改名，
# 但 code 固定，保证未指定渠道的预订仍有稳定归属）；「历史来源」承载
# 无法归因的 legacy 数据（Migration 回填目标）。
SYSTEM_CHANNELS: list[tuple[str, str, str, int]] = [
    # (code, name, category, sort_order)
    ("SYS_MEITUAN", "美团", "OTA", 10),
    ("SYS_CTRIP", "携程", "OTA", 20),
    ("SYS_FLIGGY", "飞猪", "OTA", 30),
    ("SYS_DIRECT", "直订", "DIRECT", 40),
    ("SYS_PHONE", "电话", "OFFLINE", 50),
    ("SYS_WECHAT", "微信", "OFFLINE", 60),
    ("SYS_WALK_IN", "散客", "OFFLINE", 70),
    ("SYS_CORPORATE", "协议客户", "CORPORATE", 80),
    ("CUSTOM_OTHER", "其他", "OTHER", 900),
    ("CUSTOM_LEGACY", "历史来源", "OTHER", 990),
]


def seed_channels(db: Session) -> None:
    """幂等 upsert 预置渠道（按 code 定位，回退按 name 定位）。

    - 渠道不存在 -> 创建（enabled=true, is_system=true）
    - 已存在 -> 校准 code / category / sort_order / is_system；
      **不覆盖 enabled**（经营者停用是业务决策，seed 不得把渠道悄悄启用回来）
      也**不覆盖 name**（CUSTOM_OTHER / CUSTOM_LEGACY 允许经营者改名）。

    按 name 回退定位是为了容忍「迁移插入时 name 已存在但 code 不同」的库
    （name 全局唯一，此时直接以 name 为准并校准 code，保证与
    alembic/versions/a96b1c4d7e02 的 SYSTEM_CHANNELS 完全一致）。
    """
    for code, name, category, sort_order in SYSTEM_CHANNELS:
        channel = db.scalar(select(Channel).where(Channel.code == code))
        if channel is None:
            channel = db.scalar(select(Channel).where(Channel.name == name))
        if channel is None:
            db.add(
                Channel(
                    code=code,
                    name=name,
                    category=ChannelCategory(category),
                    enabled=True,
                    is_system=True,
                    sort_order=sort_order,
                )
            )
            continue
        channel.code = code
        channel.category = ChannelCategory(category)
        channel.sort_order = sort_order
        channel.is_system = True


def seed() -> None:
    db = SessionLocal()
    try:
        perms = seed_permissions(db)
        roles = seed_roles(db, perms)
        seed_admin(db, roles["SUPER_ADMIN"])
        types_by_name = seed_room_types(db)
        seed_rooms(db, types_by_name)
        seed_inventory_locations(db)
        seed_channels(db)
        db.commit()

        print("种子数据写入完成：")
        print(f"  permissions:   {_count(db, Permission)}")
        print(f"  roles:         {_count(db, Role)}")
        print(f"  role_permissions: {_count(db, RolePermission)}")
        print(f"  users:         {_count(db, User)}")
        print(f"  room_types:    {_count(db, RoomType)}")
        print(f"  rooms:         {_count(db, Room)}")
        print(f"  channels:      {_count(db, Channel)}")
        print(f"  inventory_locations: {_count(db, InventoryLocation)}")
        admin = db.scalar(
            select(User).where(User.username == ADMIN_USERNAME)
        )
        print(f"  admin 存在且启用: {admin is not None and admin.is_active}")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    import sys

    # Windows 管道/控制台默认 GBK，强制 UTF-8 输出避免中文乱码
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    seed()
