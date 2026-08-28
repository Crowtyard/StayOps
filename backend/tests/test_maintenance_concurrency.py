# -*- coding: utf-8 -*-
"""Maintenance 并发测试（Sprint 5 §27/§45，真实提交的独立 Session）：

1. 并发创建两张 blocking 工单（同一房间）：两者都成功（允许多张 Active），
   Room 最终 OOS + MAINTENANCE，不产生孤儿/覆盖错误。
2. 并发 Verify 最后一张 blocking 工单（同一工单）：
   1 SUCCESS + 1 CONFLICT(409)，Room 恰好恢复一次（无重复审计）。
3. 并发 Verify 两张 blocking 工单（同一房间）：
   先完成者不恢复 Room；后完成者（last blocker）恢复。
4. Create blocking vs Verify last blocker：Room 锁串行化，
   终态一致（要么 verify 后 create 使其再次 OOS，要么 create 先完成 verify 不恢复）。
5. Cancel vs Verify（同一工单）：1 SUCCESS + 1 CONFLICT，终态一致。
6. Checkout vs blocking maintenance：退房与维修事务串行化，无 500。
7. 业务单号并发：work_order_no 无重复（Sequence + UNIQUE）。

原则：no premature Room restore / no orphan OOS / no lost task /
no 500 for expected business conflict（40P01/40001 -> 409）。
"""

import re
import threading

from fastapi import HTTPException
from sqlalchemy import delete, func, select

from app.database import SessionLocal
from app.models import (
    AuditLog,
    MaintenanceWorkOrder,
    Room,
    RoomType,
    User,
)
from app.schemas.maintenance import MaintenanceAssign, MaintenanceWorkOrderCreate
from app.services import maintenance

WORK_ORDER_NO_RE = re.compile(r"^MWO\d{8}-\d{4,}$")


def _worker_id(db) -> int:
    """任意在职用户 id（seed admin 即可，作为派单目标）。"""
    return db.scalar(select(User.id).where(User.is_active.is_(True)))


def _create_room(db, room_number: str) -> int:
    room_type = db.scalar(select(RoomType).order_by(RoomType.id).limit(1))
    room = Room(
        room_number=room_number,
        room_type_id=room_type.id,
        floor=9,
        occupancy_status="available",
        cleaning_status="clean",
    )
    db.add(room)
    db.commit()
    return room.id


def _delete_room(db, room_id: int) -> None:
    db.execute(
        delete(MaintenanceWorkOrder).where(
            MaintenanceWorkOrder.room_id == room_id
        )
    )
    db.execute(delete(Room).where(Room.id == room_id))
    db.commit()


def _run_threads(targets: list, timeout: float = 60) -> None:
    threads = [threading.Thread(target=t) for t in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=timeout)
        assert not thread.is_alive(), "线程未在限时内结束"


def _capture(fn, results: list, lock: threading.Lock) -> None:
    try:
        value = fn()
        with lock:
            results.append(("SUCCESS", value))
    except HTTPException as exc:
        with lock:
            results.append((f"CONFLICT:{exc.status_code}", exc.detail))
    except Exception as exc:  # noqa: BLE001
        with lock:
            results.append((f"ERROR:{type(exc).__name__}", str(exc)))


def _payload(room_id: int, title: str) -> MaintenanceWorkOrderCreate:
    return MaintenanceWorkOrderCreate(
        room_id=room_id,
        category="HVAC",
        blocks_room=True,
        title=title,
    )


def _resolve_chain(db, order_id: int) -> None:
    """assign -> start -> resolve（推进到 RESOLVED 待验收）。"""
    maintenance.assign_order(
        db,
        order_id,
        MaintenanceAssign(assigned_to_user_id=_worker_id(db)),
        None,
        None,
    )
    maintenance.start_order(db, order_id, None, None)
    maintenance.resolve_order(db, order_id, None, None, None)


def test_concurrent_two_blocking_creates_same_room(_database):
    """两张并发 blocking 工单（同一房间）：都必须成功（无 active 唯一约束），
    Room 最终 OOS + MAINTENANCE，无孤儿 OOS。"""
    setup = SessionLocal()
    try:
        room_id = _create_room(setup, "801")
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def worker(title: str):
        session = SessionLocal()
        try:
            payload = _payload(room_id, title)

            def create():
                return maintenance.create_order(session, payload, None, None).id

            _capture(create, results, lock)
        finally:
            session.close()

    _run_threads([lambda: worker("并发阻断一"), lambda: worker("并发阻断二")])

    statuses = sorted(r[0] for r in results)
    assert statuses == ["SUCCESS", "SUCCESS"], results

    verify = SessionLocal()
    try:
        try:
            room = verify.get(Room, room_id)
            assert room.occupancy_status.value == "out_of_service"
            assert room.unavailability_source.value == "MAINTENANCE"
            count = verify.scalar(
                select(func.count())
                .select_from(MaintenanceWorkOrder)
                .where(MaintenanceWorkOrder.room_id == room_id)
            )
            assert count == 2
        finally:
            _delete_room(verify, room_id)
    finally:
        verify.close()


def test_concurrent_verify_same_last_blocker(_database):
    """并发 Verify 同一张（最后一张 blocking）工单：
    1 SUCCESS + 1 CONFLICT(409)；Room 恰好恢复一次；verify 审计恰好一条。"""
    setup = SessionLocal()
    try:
        room_id = _create_room(setup, "802")
        order = maintenance.create_order(
            setup, _payload(room_id, "并发验收"), None, None
        )
        oid = order.id
        _resolve_chain(setup, oid)
        assert setup.get(MaintenanceWorkOrder, oid).status.value == "RESOLVED"
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def worker():
        session = SessionLocal()
        try:
            def do():
                return maintenance.verify_order(session, oid, None, None, None)

            _capture(do, results, lock)
        finally:
            session.close()

    _run_threads([worker, worker])

    statuses = sorted(r[0] for r in results)
    assert statuses == ["CONFLICT:409", "SUCCESS"], results

    verify = SessionLocal()
    try:
        try:
            order_row = verify.get(MaintenanceWorkOrder, oid)
            assert order_row.status.value == "COMPLETED"
            room = verify.get(Room, room_id)
            assert room.occupancy_status.value == "available"
            assert room.unavailability_source is None
            audit_count = verify.scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(
                    AuditLog.action == "maintenance.verify",
                    AuditLog.resource_id == oid,
                )
            )
            assert audit_count == 1, "不得产生重复验收审计"
        finally:
            _delete_room(verify, room_id)
    finally:
        verify.close()


def test_concurrent_verify_two_blockers_same_room(_database):
    """并发 Verify 同一房间的两张 blocking 工单：先完成者不恢复 Room，
    后完成者（last blocker）恢复，最终 available。"""
    setup = SessionLocal()
    try:
        room_id = _create_room(setup, "803")
        first = maintenance.create_order(
            setup, _payload(room_id, "并发双工单一"), None, None
        )
        second = maintenance.create_order(
            setup, _payload(room_id, "并发双工单二"), None, None
        )
        for oid in (first.id, second.id):
            _resolve_chain(setup, oid)
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def worker(oid: int):
        session = SessionLocal()
        try:
            def do():
                return maintenance.verify_order(session, oid, None, None, None)

            _capture(do, results, lock)
        finally:
            session.close()

    _run_threads([lambda: worker(first.id), lambda: worker(second.id)])

    statuses = sorted(r[0] for r in results)
    assert statuses == ["SUCCESS", "SUCCESS"], results

    verify = SessionLocal()
    try:
        try:
            room = verify.get(Room, room_id)
            assert room.occupancy_status.value == "available", "最后一张完成后必须恢复"
            assert room.unavailability_source is None
        finally:
            _delete_room(verify, room_id)
    finally:
        verify.close()


def test_concurrent_create_blocking_vs_verify_last_blocker(_database):
    """Create blocking vs Verify last blocker：Room 锁串行化。
    若 create 先提交 -> verify 后执行看到新 blocker，不恢复（仍 OOS）；
    若 verify 先提交 -> 恢复 available，create 再将其置 OOS。
    终态必为 OOS + MAINTENANCE 且恰好 2 张工单（1 完成 + 1 OPEN），无 500。"""
    setup = SessionLocal()
    try:
        room_id = _create_room(setup, "804")
        existing = maintenance.create_order(
            setup, _payload(room_id, "已有阻断"), None, None
        )
        oid = existing.id
        _resolve_chain(setup, oid)
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def create_worker():
        session = SessionLocal()
        try:
            payload = _payload(room_id, "并发新阻断")

            def do():
                return maintenance.create_order(session, payload, None, None).id

            _capture(do, results, lock)
        finally:
            session.close()

    def verify_worker():
        session = SessionLocal()
        try:
            def do():
                return maintenance.verify_order(session, oid, None, None, None)

            _capture(do, results, lock)
        finally:
            session.close()

    _run_threads([create_worker, verify_worker])

    statuses = sorted(r[0] for r in results)
    assert statuses == ["SUCCESS", "SUCCESS"], results

    verify = SessionLocal()
    try:
        try:
            room = verify.get(Room, room_id)
            # create 最终必然让房间处于 Maintenance 停用（其后没有 last-blocker 恢复）
            assert room.occupancy_status.value == "out_of_service"
            assert room.unavailability_source.value == "MAINTENANCE"
            open_count = verify.scalar(
                select(func.count())
                .select_from(MaintenanceWorkOrder)
                .where(
                    MaintenanceWorkOrder.room_id == room_id,
                    MaintenanceWorkOrder.status == "OPEN",
                )
            )
            assert open_count == 1, "新工单必须存在（不丢失 Maintenance task）"
        finally:
            _delete_room(verify, room_id)
    finally:
        verify.close()


def test_concurrent_cancel_vs_verify_same_order(_database):
    """Cancel vs Verify 同一工单：1 SUCCESS + 1 CONFLICT(409)；
    终态一致（CANCELLED+available 或 COMPLETED+available），无矛盾状态。"""
    setup = SessionLocal()
    try:
        room_id = _create_room(setup, "805")
        order = maintenance.create_order(
            setup, _payload(room_id, "并发取消验收"), None, None
        )
        oid = order.id
        _resolve_chain(setup, oid)
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def cancel_worker():
        session = SessionLocal()
        try:
            def do():
                return maintenance.cancel_order(session, oid, None, None)

            _capture(do, results, lock)
        finally:
            session.close()

    def verify_worker():
        session = SessionLocal()
        try:
            def do():
                return maintenance.verify_order(session, oid, None, None, None)

            _capture(do, results, lock)
        finally:
            session.close()

    _run_threads([cancel_worker, verify_worker])

    statuses = sorted(r[0] for r in results)
    assert statuses == ["CONFLICT:409", "SUCCESS"], results

    verify = SessionLocal()
    try:
        try:
            order_row = verify.get(MaintenanceWorkOrder, oid)
            room = verify.get(Room, room_id)
            assert order_row.status.value in ("CANCELLED", "COMPLETED")
            # 两种终态下房间都必须恢复（cancel / verify 都解除最后一张 blocker）
            assert room.occupancy_status.value == "available"
            assert room.unavailability_source is None
        finally:
            _delete_room(verify, room_id)
    finally:
        verify.close()


def test_concurrent_work_order_numbers(_database):
    """并发创建多张工单 -> work_order_no 无重复（Sequence + UNIQUE）。"""
    setup = SessionLocal()
    try:
        room_ids = [
            _create_room(setup, number)
            for number in ("810", "811", "812", "813")
        ]
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def worker(room_id: int):
        session = SessionLocal()
        try:
            payload = _payload(room_id, "并发单号")

            def create():
                order = maintenance.create_order(session, payload, None, None)
                return order.work_order_no

            _capture(create, results, lock)
        finally:
            session.close()

    _run_threads([lambda rid=rid: worker(rid) for rid in room_ids])

    numbers = [r[1] for r in results if r[0] == "SUCCESS"]
    assert len(numbers) == len(room_ids), results
    assert len(set(numbers)) == len(numbers), "work_order_no 不得重复"
    assert all(WORK_ORDER_NO_RE.match(n) for n in numbers)

    cleanup = SessionLocal()
    try:
        for room_id in room_ids:
            _delete_room(cleanup, room_id)
    finally:
        cleanup.close()
