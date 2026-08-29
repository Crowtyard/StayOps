# -*- coding: utf-8 -*-
"""Analytics 测试共用工具（Sprint 8）。

Golden Analytics Dataset（§52/§53）：
- 使用真实 API 链路（TestClient + stayops_test 库）创建业务事实，
  再以与业务同源的 ORM 对关键时间戳做确定性回填（backdate，与
  setup_overdue_stay.py 同模式），使全部指标可人工手算。
- 所有日期基于 Property Business Date（Asia/Shanghai）动态生成；
  Expected Values 在测试代码中以字面量写出（不依赖随机日期）。
- 用例级事务回滚隔离，跨用例互不污染。

Golden 窗口：period = [d(-6), d(0))，business_date = d(0)。
"""

from datetime import datetime, timedelta

from sqlalchemy import select

from app.core.business_date import business_date, PROPERTY_UTC_OFFSET
from app.models import (
    GoodsReceipt,
    HousekeepingTask,
    MaintenanceWorkOrder,
    PurchaseOrder,
    PurchaseRequest,
    Reservation,
    Stay,
    StayRoomAssignment,
    StockMovement,
)

from tests.booking_helpers import (
    check_in,
    check_out,
    create_guest,
    create_reservation,
    find_room,
)
from tests import hk_helpers, inventory_helpers as inv, mwo_helpers


def d(days: int):
    """business_date + N 天。"""
    return business_date() + timedelta(days=days)


def iso(value) -> str:
    """date -> YYYY-MM-DD。"""
    return value.isoformat()


def ts(days: int, hour: int = 12, minute: int = 0) -> datetime:
    """确定性时间戳：business_date + N 天 hour:minute（Asia/Shanghai）。"""
    return datetime.combine(
        d(days), datetime.min.time().replace(hour=hour, minute=minute)
    ).replace(tzinfo=PROPERTY_UTC_OFFSET)


def backdate(db, model, row_id: int, **fields) -> None:
    """以 ORM 确定性回填时间戳（不经过业务状态机，仅测试数据准备）。"""
    row = db.get(model, row_id)
    assert row is not None, f"{model.__name__} #{row_id} 不存在"
    for key, value in fields.items():
        setattr(row, key, value)


def get_analytics(client, headers, path: str, params: dict | None = None, expect: int = 200):
    resp = client.get(
        f"/api/v1/analytics/{path}", params=params or {}, headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def build_stay(client, db, headers, room, *, ci, co, amount, moves=None,
               checkout=True, planned_co_days=None, guest_name="边界测试客",
               phone="13911112222"):
    """构造一个 Stay（真实 API 链路 + 确定性时间戳回填）。

    ci / co = (days, hour, minute?) 实际入住 / 退房时刻；
    moves = [(target_room_id, reason, (days, hour, minute?))] 换房事件（按顺序）；
    checkout=False 时保持 ACTIVE；planned_co_days 覆盖计划退房日。
    返回 {"reservation": ..., "stay": ..., "stay_id": ...}。
    """
    guest = create_guest(client, headers, name=guest_name, phone=phone)
    reservation = create_reservation(
        client, headers, room=room, guest_id=guest["id"], amount=amount
    )
    ci_resp = check_in(client, headers, reservation["id"])
    stay = ci_resp["stay"]
    for target_room_id, reason, move_ts in (moves or []):
        resp = client.post(
            f"/api/v1/stays/{stay['id']}/room-move",
            json={"target_room_id": target_room_id, "reason": reason},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
    if checkout:
        check_out(client, headers, stay["id"])

    backdate(db, Reservation, reservation["id"],
             check_in_date=d(ci[0]), check_out_date=d(co[0]))
    stay_fields: dict = {"actual_check_in_at": ts(*ci)}
    if checkout:
        stay_fields["actual_check_out_at"] = ts(*co)
    if planned_co_days is not None:
        stay_fields["planned_check_out_date"] = d(planned_co_days)
    backdate(db, Stay, stay["id"], **stay_fields)

    rows = db.scalars(
        select(StayRoomAssignment)
        .where(StayRoomAssignment.stay_id == stay["id"])
        .order_by(StayRoomAssignment.id)
    ).all()
    assert len(rows) == 1 + len(moves or []), "assignment 数量应与 入住+换房 一致"
    # 回填采用「删除后按最终区间重建」：API 生成的原始 assignment 区间是
    # 微秒级非空小区间（[check_in, move) 等），与排他约束
    # ex_stay_room_assignments_no_overlap（立即检查、不可延迟）叠加时，
    # 任何逐行 UPDATE 顺序都会存在中间状态冲突（与回填时刻相对“现在”
    # 的位置无关）。重建后的区间天然首尾相邻、恒合法；测试事务回滚，无副作用。
    move_spec = moves or []
    for row in rows:
        db.delete(row)
    db.flush()
    for i in range(len(move_spec) + 1):
        db.add(
            StayRoomAssignment(
                stay_id=stay["id"],
                room_id=(room["id"] if i == 0 else move_spec[i - 1][0]),
                started_at=(ts(*ci) if i == 0 else ts(*move_spec[i - 1][2])),
                ended_at=(
                    ts(*move_spec[i][2])
                    if i < len(move_spec)
                    else (ts(*co) if checkout else None)
                ),
                reason=(None if i == 0 else move_spec[i - 1][1]),
                created_by=None,
            )
        )
    db.flush()
    return {"reservation": reservation, "stay": stay, "stay_id": stay["id"]}


# ---------------------------------------------------------------------------
# Golden Dataset 构造
# ---------------------------------------------------------------------------

GOLDEN_ROOMS = ("101", "102", "103", "104", "105", "106", "107", "108", "109")


def build_golden(client, db, headers) -> dict:
    """构造 Golden Analytics Dataset，返回 {rooms, stays, reservations, items, ...}。

    指标人工期望值（见 test_analytics_golden.py 的断言注释）：
    - occupied room nights   = 13（S1:2 + S2:3 + S3:2 + S4:4 + S5:2）
    - physical room nights   = 28 × 6 = 168；physical occupancy ≈ 0.0774
    - completed stays = 3（S1/S2/S5）；ALOS = 7/3 ≈ 2.3333
    - arrival cohort = 7（R1..R7）；cancelled 1 → 0.1429；no-show 1 → 1/6 ≈ 0.1667
    - avg lead = (3+5+2+2+0+5)/6 = 17/6 ≈ 2.8；buckets 0-1:1 / 2-3:3 / 4-7:2
    - room moves = 1（S2 102→103，GUEST_REQUEST）；moved stays = 1；rate = 1/5 = 0.2
    - contracted value = 3550.00（800+1200+450+600+500）；priced 12 / unpriced 1
      ADR = 3550/12 ≈ 295.8333；RevPAR = 3550/168 ≈ 21.1310
    - HK：completed 3 / cycle 110.0 / checkout 120.0 / ROOM_MOVE tasks 1 / backlog 1
    - Maintenance：created 4 / completed 2 / active 2 / blocking 1 /
      MTTR 750.0 / verification 60.0
    - Inventory：low 1 / out 1；A issue 15（15/13≈1.1538）、B 3（≈0.2308）、C 0、D 0
    - Procurement：PR created 2 / pending 1 / PO created 2 / pending receipt 1 /
      partially 1 / received value 210.00 / unpriced lines 1
    - Forecast：7d = 6/196 ≈ 0.0306；14d = 7/392 ≈ 0.0179；30d = 7/840 ≈ 0.0083
    """
    result: dict = {"rooms": {}, "stays": {}, "reservations": {}, "items": {}}

    for room_no in GOLDEN_ROOMS:
        result["rooms"][room_no] = find_room(client, headers, room_no)

    g1 = create_guest(client, headers, name="黄金测试客一", phone="13900000001",
                      notes="金色数据集备注一")

    # ---- S1：COMPLETED，2 晚 [d-5, d-3)，金额 800 → 400/晚 ----
    r1 = create_reservation(client, headers, room=result["rooms"]["101"],
                            guest_id=g1["id"], amount="800.00")
    result["reservations"]["R1"] = r1
    ci1 = check_in(client, headers, r1["id"])
    s1 = ci1["stay"]
    result["stays"]["S1"] = s1
    co1 = check_out(client, headers, s1["id"])
    result["reservations"]["R1"] = co1["reservation"]

    # ---- S2：COMPLETED + Room Move 102→103，3 晚 [d-5, d-2)，1200 → 400/晚 ----
    r2 = create_reservation(client, headers, room=result["rooms"]["102"],
                            guest_id=g1["id"], amount="1200.00")
    result["reservations"]["R2"] = r2
    ci2 = check_in(client, headers, r2["id"])
    s2 = ci2["stay"]
    result["stays"]["S2"] = s2
    move2 = client.post(
        f"/api/v1/stays/{s2['id']}/room-move",
        json={"target_room_id": result["rooms"]["103"]["id"],
              "reason": "GUEST_REQUEST"},
        headers=headers,
    )
    assert move2.status_code == 200, move2.text
    co2 = check_out(client, headers, s2["id"])
    result["reservations"]["R2"] = co2["reservation"]

    # ---- S3：ACTIVE（不超期），[d-2, d(2))，900 → 225/晚 ----
    r3 = create_reservation(client, headers, room=result["rooms"]["104"],
                            guest_id=g1["id"], amount="900.00")
    result["reservations"]["R3"] = r3
    ci3 = check_in(client, headers, r3["id"])
    s3 = ci3["stay"]
    result["stays"]["S3"] = s3

    # ---- S4：ACTIVE 超期（planned d-1 <= D0），计划 [d-4, d-1)，600 → 200/晚 ----
    r4 = create_reservation(client, headers, room=result["rooms"]["105"],
                            guest_id=g1["id"], amount="600.00")
    result["reservations"]["R4"] = r4
    ci4 = check_in(client, headers, r4["id"])
    s4 = ci4["stay"]
    result["stays"]["S4"] = s4

    # ---- S5：COMPLETED，2 晚 [d-6, d-4)，500 → 250/晚 ----
    r5 = create_reservation(client, headers, room=result["rooms"]["106"],
                            guest_id=g1["id"], amount="500.00")
    result["reservations"]["R5"] = r5
    ci5 = check_in(client, headers, r5["id"])
    s5 = ci5["stay"]
    result["stays"]["S5"] = s5
    co5 = check_out(client, headers, ci5["stay"]["id"])
    result["reservations"]["R5"] = co5["reservation"]

    # ---- R6：CANCELLED（Arrival Cohort）----
    r6 = create_reservation(client, headers, room=result["rooms"]["107"],
                            guest_id=g1["id"], amount="300.00")
    result["reservations"]["R6"] = r6
    cancel6 = client.post(f"/api/v1/reservations/{r6['id']}/cancel", headers=headers)
    assert cancel6.status_code == 200, cancel6.text
    result["reservations"]["R6"] = cancel6.json()

    # ---- R7：NO_SHOW（Arrival Cohort）；R8..R11 未来预订（Forecast）----
    r7 = create_reservation(client, headers, room=result["rooms"]["108"],
                            guest_id=g1["id"], amount="400.00")
    result["reservations"]["R7"] = r7
    noshow7 = client.post(f"/api/v1/reservations/{r7['id']}/no-show", headers=headers)
    assert noshow7.status_code == 200, noshow7.text
    result["reservations"]["R7"] = noshow7.json()

    r8 = create_reservation(client, headers, room=result["rooms"]["108"],
                            guest_id=g1["id"], check_in=d(1), check_out=d(3),
                            amount="600.00")
    result["reservations"]["R8"] = r8

    r9 = create_reservation(client, headers, room=result["rooms"]["109"],
                            guest_id=g1["id"], check_in=d(2), check_out=d(4),
                            amount="500.00")
    result["reservations"]["R9"] = r9
    cancel9 = client.post(f"/api/v1/reservations/{r9['id']}/cancel", headers=headers)
    assert cancel9.status_code == 200, cancel9.text
    result["reservations"]["R9"] = cancel9.json()

    # R10：NO_SHOW（No-show 资格要求 business_date >= check_in，先按今天创建再回填日期）
    r10 = create_reservation(client, headers, room=find_room(client, headers, "110"),
                             guest_id=g1["id"], amount="500.00")
    result["reservations"]["R10"] = r10
    noshow10 = client.post(f"/api/v1/reservations/{r10['id']}/no-show", headers=headers)
    assert noshow10.status_code == 200, noshow10.text
    result["reservations"]["R10"] = noshow10.json()

    r11 = create_reservation(client, headers, room=find_room(client, headers, "201"),
                             guest_id=g1["id"], check_in=d(5), check_out=d(8),
                             amount="900.00")
    result["reservations"]["R11"] = r11

    # ------------------------------------------------------------------
    # 时间戳回填（Reservation / Stay / Assignment）
    # ------------------------------------------------------------------
    # 预订提前天数（非 CANCELLED cohort：R1=3, R2=5, R3=2, R4=2, R5=0, R7=5）
    backdate(db, Reservation, r1["id"], created_at=ts(-8, 9, 0))
    backdate(db, Reservation, r2["id"], created_at=ts(-10, 9, 0))
    backdate(db, Reservation, r3["id"], created_at=ts(-4, 9, 0))
    backdate(db, Reservation, r4["id"], created_at=ts(-6, 9, 0))
    backdate(db, Reservation, r5["id"], created_at=ts(-6, 12, 0))
    backdate(db, Reservation, r7["id"], created_at=ts(-7, 9, 0))

    backdate(db, Reservation, r1["id"], check_in_date=d(-5), check_out_date=d(-3))
    backdate(db, Reservation, r2["id"], check_in_date=d(-5), check_out_date=d(-2))
    backdate(db, Reservation, r3["id"], check_in_date=d(-2), check_out_date=d(2))
    backdate(db, Reservation, r4["id"], check_in_date=d(-4), check_out_date=d(-1))
    backdate(db, Reservation, r5["id"], check_in_date=d(-6), check_out_date=d(-4))
    backdate(db, Reservation, r6["id"], check_in_date=d(-3), check_out_date=d(-1))
    backdate(db, Reservation, r7["id"], check_in_date=d(-2), check_out_date=d(0))
    backdate(db, Reservation, r10["id"], check_in_date=d(2), check_out_date=d(4))

    # Stay 实际区间（ACTIVE 使用 [check_in_bd, D0)，不被 planned_checkout 截断）
    backdate(db, Stay, s1["id"], actual_check_in_at=ts(-5, 14, 0),
             actual_check_out_at=ts(-3, 10, 0))
    backdate(db, Stay, s2["id"], actual_check_in_at=ts(-5, 14, 0),
             actual_check_out_at=ts(-2, 10, 0))
    backdate(db, Stay, s3["id"], actual_check_in_at=ts(-2, 13, 0))
    backdate(db, Stay, s4["id"], actual_check_in_at=ts(-4, 15, 0),
             planned_check_out_date=d(-1))
    backdate(db, Stay, s5["id"], actual_check_in_at=ts(-6, 13, 0),
             actual_check_out_at=ts(-4, 9, 0))

    # Assignments：初始 assignment started_at = 入住时刻；CHECKED_OUT 关闭 ended_at；
    # S2 换房区间 [d-5 14:00, d-4 09:00) + [d-4 09:00, d-2 10:00)
    stay_ids = [s1["id"], s2["id"], s3["id"], s4["id"], s5["id"]]
    assignments = db.scalars(
        select(StayRoomAssignment).where(StayRoomAssignment.stay_id.in_(stay_ids))
    ).all()
    by_stay: dict[int, list[StayRoomAssignment]] = {}
    for a in assignments:
        by_stay.setdefault(a.stay_id, []).append(a)
    init_ts = {
        s1["id"]: ts(-5, 14, 0), s2["id"]: ts(-5, 14, 0), s3["id"]: ts(-2, 13, 0),
        s4["id"]: ts(-4, 15, 0), s5["id"]: ts(-6, 13, 0),
    }
    for stay_id, rows in by_stay.items():
        rows.sort(key=lambda a: a.id)
        rows[0].started_at = init_ts[stay_id]
        stay = db.get(Stay, stay_id)
        if stay.status == "CHECKED_OUT":
            rows[-1].ended_at = stay.actual_check_out_at
    s2_rows = sorted(by_stay[s2["id"]], key=lambda a: a.id)
    assert len(s2_rows) == 2, "S2 应有 2 条 assignment（入住 + 换房）"
    s2_rows[0].ended_at = ts(-4, 9, 0)
    s2_rows[1].started_at = ts(-4, 9, 0)
    db.flush()

    # ------------------------------------------------------------------
    # Housekeeping（§23）
    # T1 CHECKOUT（S1 退房自动，room 101）、T3 ROOM_MOVE（S2 换房自动，room 102）
    # T2 MANUAL（107）、T4 PENDING backlog（108）、T5 CANCELLED（109）
    # S2 退房自动任务（room 103）与 S5 退房自动任务（room 106）→ 取消，不计入完成/积压
    # ------------------------------------------------------------------
    hk_helpers.make_dirty(client, headers, "107")
    t2 = hk_helpers.create_task(client, headers, result["rooms"]["107"]["id"])
    for action in ("start", "submit-inspection", "pass"):
        hk_helpers.task_action(client, headers, t2["id"], action)

    hk_helpers.make_dirty(client, headers, "108")
    t4 = hk_helpers.create_task(client, headers, result["rooms"]["108"]["id"])

    hk_helpers.make_dirty(client, headers, "109")
    t5 = hk_helpers.create_task(client, headers, result["rooms"]["109"]["id"])
    hk_helpers.task_action(client, headers, t5["id"], "cancel")

    task_room_ids = [result["rooms"][r]["id"] for r in ("101", "102", "103", "106",
                                                        "107", "108", "109")]
    tasks = db.scalars(
        select(HousekeepingTask).where(HousekeepingTask.room_id.in_(task_room_ids))
    ).all()
    task_by_room: dict[int, HousekeepingTask] = {t.room_id: t for t in tasks}
    t1 = task_by_room[result["rooms"]["101"]["id"]]
    t3 = task_by_room[result["rooms"]["102"]["id"]]
    t103 = task_by_room.get(result["rooms"]["103"]["id"])
    t106 = task_by_room.get(result["rooms"]["106"]["id"])
    assert t1 is not None and t1.source == "CHECKOUT", "S1 退房应自动创建 CHECKOUT 任务"
    assert t3 is not None and t3.source == "ROOM_MOVE", "S2 换房应自动创建 ROOM_MOVE 任务"
    assert t103 is not None and t106 is not None, "S2/S5 退房应自动创建 CHECKOUT 任务"

    # 完成 T1 / T3（T2 已通过 API 完成）
    for t in (t1, t3):
        hk_helpers.task_action(client, headers, t.id, "start")
        hk_helpers.task_action(client, headers, t.id, "submit-inspection")
        hk_helpers.task_action(client, headers, t.id, "pass")
    # 取消 S2/S5 退房自动任务（不计入 completed / backlog）
    hk_helpers.task_action(client, headers, t103.id, "cancel")
    hk_helpers.task_action(client, headers, t106.id, "cancel")

    db.expire_all()
    t1 = db.get(HousekeepingTask, t1.id)
    t3 = db.get(HousekeepingTask, t3.id)
    t2 = db.get(HousekeepingTask, t2["id"])
    t4 = db.get(HousekeepingTask, t4["id"])
    t5 = db.get(HousekeepingTask, t5["id"])
    t103 = db.get(HousekeepingTask, t103.id)
    t106 = db.get(HousekeepingTask, t106.id)
    # T1：created d-3 10:00 / completed d-3 12:00（120 分钟）
    backdate(db, HousekeepingTask, t1.id, created_at=ts(-3, 10, 0),
             started_at=ts(-3, 10, 30), submitted_for_inspection_at=ts(-3, 11, 30),
             completed_at=ts(-3, 12, 0))
    # T2：created d-2 09:00 / completed d-2 11:30（150 分钟，MANUAL）
    backdate(db, HousekeepingTask, t2.id, created_at=ts(-2, 9, 0),
             started_at=ts(-2, 9, 30), submitted_for_inspection_at=ts(-2, 11, 0),
             completed_at=ts(-2, 11, 30))
    # T3：created d-4 09:00 / completed d-4 10:00（60 分钟，ROOM_MOVE）
    backdate(db, HousekeepingTask, t3.id, created_at=ts(-4, 9, 0),
             started_at=ts(-4, 9, 15), submitted_for_inspection_at=ts(-4, 9, 45),
             completed_at=ts(-4, 10, 0))
    # T4：backlog，created d-1 16:00（保持 PENDING）
    backdate(db, HousekeepingTask, t4.id, created_at=ts(-1, 16, 0))
    # T5：CANCELLED，created d-2 08:00 / cancelled d-2 09:00
    backdate(db, HousekeepingTask, t5.id, created_at=ts(-2, 8, 0),
             cancelled_at=ts(-2, 9, 0))
    # 103 / 106 的退房任务：取消且不在完成/积压口径内
    backdate(db, HousekeepingTask, t103.id, created_at=ts(-2, 10, 0),
             cancelled_at=ts(-2, 12, 0))
    backdate(db, HousekeepingTask, t106.id, created_at=ts(-4, 10, 0),
             cancelled_at=ts(-4, 12, 0))
    db.flush()

    # ------------------------------------------------------------------
    # Maintenance（§24）：M1 完成 / M2 完成（阻断）/ M3 OPEN 阻断 / M4 ASSIGNED 非阻断
    # ------------------------------------------------------------------
    admin_id = mwo_helpers.me_user_id(client, headers)
    m1 = mwo_helpers.create_order(
        client, headers, room_id=result["rooms"]["101"]["id"],
        category="HVAC", severity="MEDIUM", blocks_room=False, title="空调异响",
    )
    mwo_helpers.assign_order(client, headers, m1["id"], admin_id)
    mwo_helpers.order_action(client, headers, m1["id"], "start")
    mwo_helpers.order_action(client, headers, m1["id"], "resolve")
    mwo_helpers.order_action(client, headers, m1["id"], "verify")

    m2 = mwo_helpers.create_order(
        client, headers, room_id=result["rooms"]["104"]["id"],
        category="PLUMBING", severity="HIGH", blocks_room=True, title="浴室渗水",
    )
    mwo_helpers.assign_order(client, headers, m2["id"], admin_id)
    mwo_helpers.order_action(client, headers, m2["id"], "start")
    mwo_helpers.order_action(client, headers, m2["id"], "resolve")
    mwo_helpers.order_action(client, headers, m2["id"], "verify")

    m3 = mwo_helpers.create_order(
        client, headers, room_id=result["rooms"]["102"]["id"],
        category="LOCK", severity="CRITICAL", blocks_room=True, title="门锁损坏",
    )
    m4 = mwo_helpers.create_order(
        client, headers, room_id=result["rooms"]["103"]["id"],
        category="ELECTRICAL", severity="LOW", blocks_room=False, title="插座松动",
    )
    mwo_helpers.assign_order(client, headers, m4["id"], admin_id)

    # M1：created d-6 09:00 / resolved d-6 15:00 / completed d-6 16:00（MTTR 360、验收 60）
    backdate(db, MaintenanceWorkOrder, m1["id"], created_at=ts(-6, 9, 0),
             started_at=ts(-6, 10, 0), resolved_at=ts(-6, 15, 0),
             verified_at=ts(-6, 16, 0), completed_at=ts(-6, 16, 0))
    # M2：created d-5 14:00 / resolved d-4 09:00 / completed d-4 10:00（MTTR 1140、验收 60）
    backdate(db, MaintenanceWorkOrder, m2["id"], created_at=ts(-5, 14, 0),
             started_at=ts(-5, 15, 0), resolved_at=ts(-4, 9, 0),
             verified_at=ts(-4, 10, 0), completed_at=ts(-4, 10, 0))
    # M3：OPEN 阻断，created d-1 10:00
    backdate(db, MaintenanceWorkOrder, m3["id"], created_at=ts(-1, 10, 0))
    # M4：ASSIGNED 非阻断，created d-1 11:00
    backdate(db, MaintenanceWorkOrder, m4["id"], created_at=ts(-1, 11, 0))
    db.flush()

    # ------------------------------------------------------------------
    # Inventory（§26-§28）：A 水（瓶）/ B 拖鞋（双）/ C 毛巾（条）/ D 卷纸（包）
    # ------------------------------------------------------------------
    main_loc = inv.location_by_code(client, headers, "MAIN_STORAGE")
    front_loc = inv.location_by_code(client, headers, "FRONT_DESK")
    item_a = inv.create_item(client, headers, code="GOLD-WATER", name="矿泉水",
                             category="GUEST_AMENITY", base_unit="瓶",
                             minimum="10", target="50")
    item_b = inv.create_item(client, headers, code="GOLD-SLIPPER", name="拖鞋",
                             category="GUEST_AMENITY", base_unit="双",
                             minimum="5", target="20")
    item_c = inv.create_item(client, headers, code="GOLD-TOWEL", name="毛巾",
                             category="LINEN", base_unit="条", minimum="0", target="0")
    item_d = inv.create_item(client, headers, code="GOLD-PAPER", name="卷纸",
                             category="FRONT_DESK", base_unit="包",
                             minimum="0", target="10")
    item_e = inv.create_item(client, headers, code="GOLD-SHAMPOO", name="洗发水",
                             category="GUEST_AMENITY", base_unit="瓶",
                             minimum="0", target="0")
    inv.initial_stock(client, headers, item_a["id"], main_loc["id"], "50")
    inv.initial_stock(client, headers, item_b["id"], main_loc["id"], "5")
    inv.initial_stock(client, headers, item_d["id"], main_loc["id"], "20")
    # A：issue 10（d-6）+ issue 5（d-2）+ return 2（d-1）→ issue quantity = 15（不减 RETURN）
    inv.issue(client, headers, main_loc["id"],
              [{"item_id": item_a["id"], "quantity": 10}])
    inv.issue(client, headers, main_loc["id"],
              [{"item_id": item_a["id"], "quantity": 5}])
    inv.stock_return(client, headers, item_a["id"], main_loc["id"], "2")
    # B：issue 3（d-3）→ balance 2 → LOW_STOCK（B 不出现在收货单，保持低库存）
    inv.issue(client, headers, main_loc["id"],
              [{"item_id": item_b["id"], "quantity": 3}])
    # D：transfer 5 到前台（d-5）+ stocktake 12（d-4，差异 -3 → ADJUSTMENT_OUT）
    inv.transfer(client, headers, main_loc["id"], front_loc["id"],
                 [{"item_id": item_d["id"], "quantity": 5}])
    inv.stocktake(client, headers, item_d["id"], main_loc["id"], "12")
    # C / E：无任何流水 → 0 余额（C 后续有收货 +5 → NORMAL；E 保持 OUT_OF_STOCK）

    movements = db.scalars(
        select(StockMovement).where(
            StockMovement.item_id.in_([item_a["id"], item_b["id"], item_d["id"]])
        ).order_by(StockMovement.id)
    ).all()
    issue_days = {item_a["id"]: [ts(-6, 9, 0), ts(-2, 9, 0)],
                  item_b["id"]: [ts(-3, 9, 0)]}
    issue_idx: dict[int, int] = {}
    for m in movements:
        if m.movement_type == "INITIAL":
            m.created_at = ts(-8, 10, 0)
        elif m.movement_type == "ISSUE":
            idx = issue_idx.get(m.item_id, 0)
            m.created_at = issue_days[m.item_id][idx]
            issue_idx[m.item_id] = idx + 1
        elif m.movement_type == "RETURN":
            m.created_at = ts(-1, 9, 0)
        elif m.movement_type in ("TRANSFER_OUT", "TRANSFER_IN"):
            m.created_at = ts(-5, 11, 0)
        elif m.movement_type in ("ADJUSTMENT_IN", "ADJUSTMENT_OUT"):
            m.created_at = ts(-4, 9, 0)
    db.flush()

    # ------------------------------------------------------------------
    # Procurement（§29/§30）：PR1 DRAFT / PR2 APPROVED / PO1 两次收货 / PO2 无价收货
    # ------------------------------------------------------------------
    supplier = inv.create_supplier(client, headers, code="SUP-GOLD",
                                   name="泉城黄金供应商", phone="13800138888")
    pr1 = inv.create_request(client, headers,
                             [{"item_id": item_a["id"], "quantity": 50}],
                             notes="申请一")
    pr2 = inv.create_request(client, headers,
                             [{"item_id": item_b["id"], "quantity": 10}],
                             notes="申请二")
    inv.request_action(client, headers, pr2["id"], "submit")
    inv.request_action(client, headers, pr2["id"], "approve")

    po1 = inv.create_order(
        client, headers, supplier["id"],
        lines=[
            {"item_id": item_a["id"], "ordered_quantity": 100},
            {"item_id": item_d["id"], "ordered_quantity": 20},
        ],
        unit_prices={item_a["id"]: "1.50", item_d["id"]: "3.00"},
    )
    inv.order_action(client, headers, po1["id"], "order")
    po1_detail = inv.get_order(client, headers, po1["id"])
    line_a = inv.po_line(po1_detail, item_a["id"])
    line_d = inv.po_line(po1_detail, item_d["id"])
    inv.receive(client, headers, po1["id"], main_loc["id"], [
        {"purchase_order_line_id": line_a["id"], "received_quantity": 60},
        {"purchase_order_line_id": line_d["id"], "received_quantity": 10},
    ])
    inv.receive(client, headers, po1["id"], main_loc["id"], [
        {"purchase_order_line_id": line_a["id"], "received_quantity": 40},
        {"purchase_order_line_id": line_d["id"], "received_quantity": 10},
    ])

    po2 = inv.create_order(
        client, headers, supplier["id"],
        lines=[{"item_id": item_c["id"], "ordered_quantity": 10}],
    )
    inv.order_action(client, headers, po2["id"], "order")
    po2_detail = inv.get_order(client, headers, po2["id"])
    line_c = inv.po_line(po2_detail, item_c["id"])
    inv.receive(client, headers, po2["id"], main_loc["id"], [
        {"purchase_order_line_id": line_c["id"], "received_quantity": 5},
    ])

    backdate(db, PurchaseRequest, pr1["id"], created_at=ts(-5, 9, 0))
    backdate(db, PurchaseRequest, pr2["id"], created_at=ts(-3, 10, 0),
             submitted_at=ts(-3, 10, 30), approved_at=ts(-2, 10, 0))
    backdate(db, PurchaseOrder, po1["id"], created_at=ts(-2, 11, 0),
             ordered_at=ts(-2, 11, 30))
    backdate(db, PurchaseOrder, po2["id"], created_at=ts(-3, 9, 0),
             ordered_at=ts(-2, 10, 0))
    receipts = db.scalars(
        select(GoodsReceipt).where(
            GoodsReceipt.purchase_order_id.in_([po1["id"], po2["id"]])
        ).order_by(GoodsReceipt.id)
    ).all()
    assert len(receipts) == 3, "应有 3 张收货单（PO1 两次 + PO2 一次）"
    po1_receipt_ts = [ts(-2, 14, 0), ts(-1, 9, 0)]
    po1_idx = 0
    for gr in receipts:
        if gr.purchase_order_id == po1["id"]:
            gr.received_at = po1_receipt_ts[po1_idx]
            gr.created_at = po1_receipt_ts[po1_idx]
            po1_idx += 1
        else:
            gr.received_at = ts(-2, 10, 30)
            gr.created_at = ts(-2, 10, 30)
    db.flush()

    result["supplier"] = supplier
    result["items"] = {"A": item_a, "B": item_b, "C": item_c, "D": item_d,
                       "E": item_e}
    result["main_location"] = main_loc
    return result
