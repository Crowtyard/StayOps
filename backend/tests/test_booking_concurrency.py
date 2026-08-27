# -*- coding: utf-8 -*-
"""Booking 并发测试（REV-FINAL-08）。

直接使用两个线程 + 独立 Session 触发（任务书 §九要求），全部为真实提交
（不经 conftest 的外层事务连接，保证并发语义真实）。测试自建专用房号并在
结束后清理，避免污染其它用例。

依赖 _database fixture（会话级 DROP/CREATE + 迁移 + seed），
保证运行前测试库干净（并发测试的写提交会跨越用例事务隔离）。
"""

import re
import threading
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import delete, func, select

from app.database import SessionLocal
from app.models import (
    AuditLog,
    Guest,
    HousekeepingTask,
    Reservation,
    Room,
    RoomType,
    Stay,
)
from app.schemas.reservation import ReservationCreate
from app.services import booking
from tests.booking_helpers import d, today

RESERVATION_NO_RE = re.compile(r"^RSV\d{8}-\d{4,}$")
STAY_NO_RE = re.compile(r"^STY\d{8}-\d{4,}$")


def _create_room_and_guest(db, room_number: str) -> tuple[int, int]:
    """在独立（提交）会话中创建专用房间与客人。"""
    room_type = db.scalar(select(RoomType).order_by(RoomType.id).limit(1))
    room = Room(room_number=room_number, room_type_id=room_type.id, floor=9)
    guest = Guest(name=f"并发客人{room_number}", phone="13600000001")
    db.add_all([room, guest])
    db.commit()
    return room.id, guest.id


def _delete_room_and_guest(db, room_id: int, guest_id: int) -> None:
    # Sprint 3：Check-out 会为房间生成保洁任务（FK RESTRICT），先清理任务
    db.execute(delete(HousekeepingTask).where(HousekeepingTask.room_id == room_id))
    db.execute(delete(Stay).where(Stay.room_id == room_id))
    db.execute(delete(Reservation).where(Reservation.room_id == room_id))
    db.execute(delete(Guest).where(Guest.id == guest_id))
    db.execute(delete(Room).where(Room.id == room_id))
    db.commit()


def _run_threads(targets: list, timeout: float = 60) -> list:
    threads = [threading.Thread(target=t) for t in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=timeout)
        assert not thread.is_alive(), "线程未在限时内结束"
    return threads


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


def test_concurrent_double_booking(_database, monkeypatch):
    """两个并发请求抢同一 Room 同一日期：恰好 1 SUCCESS + 1 CONFLICT（409）。

    通过 barrier 保证两条线程都在 INSERT 前通过应用层预检，
    使数据库排他约束（23P01）成为最终仲裁。
    """
    setup = SessionLocal()
    try:
        room_id, guest_id = _create_room_and_guest(setup, "801")
        room = setup.get(Room, room_id)
        room_type_id = room.room_type_id
    finally:
        setup.close()

    check_in_date, check_out_date = today(), d(2)
    gate = threading.Barrier(2)

    def fake_check(db, room_obj, c_in, c_out, exclude_reservation_id=None):
        gate.wait(timeout=15)
        return (True, None)

    monkeypatch.setattr(booking, "check_room_availability", fake_check)

    results: list = []
    lock = threading.Lock()

    def worker():
        session = SessionLocal()
        try:
            payload = ReservationCreate(
                guest_id=guest_id,
                room_id=room_id,
                room_type_id=room_type_id,
                check_in_date=check_in_date,
                check_out_date=check_out_date,
                agreed_total_amount=Decimal("299.00"),
            )

            def create():
                booking.create_reservation(session, payload, None, None)
                return None

            _capture(create, results, lock)
        finally:
            session.close()

    _run_threads([worker, worker])

    statuses = sorted(r[0] for r in results)
    assert statuses == ["CONFLICT:409", "SUCCESS"], results
    conflict_detail = next(r[1] for r in results if r[0] == "CONFLICT:409")
    assert "已被预订" in conflict_detail

    verify = SessionLocal()
    try:
        try:
            count = verify.scalar(
                select(func.count())
                .select_from(Reservation)
                .where(Reservation.room_id == room_id)
            )
            assert count == 1, "数据库最终应只有 1 条预订"
        finally:
            _delete_room_and_guest(verify, room_id, guest_id)
    finally:
        verify.close()


def test_concurrent_check_in(_database):
    """并发双 Check-in 同一 Reservation：1 SUCCESS + 1 × 409，最终只有一个 Stay。"""
    setup = SessionLocal()
    try:
        room_id, guest_id = _create_room_and_guest(setup, "802")
        room = setup.get(Room, room_id)
        payload = ReservationCreate(
            guest_id=guest_id,
            room_id=room_id,
            room_type_id=room.room_type_id,
            check_in_date=today(),
            check_out_date=d(2),
            agreed_total_amount=Decimal("299.00"),
        )
        reservation = booking.create_reservation(setup, payload, None, None)
        reservation_id = reservation.id
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def worker():
        session = SessionLocal()
        try:
            def do():
                booking.check_in_reservation(session, reservation_id, None, None)
                return None

            _capture(do, results, lock)
        finally:
            session.close()

    _run_threads([worker, worker])

    statuses = sorted(r[0] for r in results)
    assert statuses == ["CONFLICT:409", "SUCCESS"], results

    verify = SessionLocal()
    try:
        try:
            stays = verify.scalars(
                select(Stay).where(Stay.reservation_id == reservation_id)
            ).all()
            assert len(stays) == 1, "最终只能有一个 Stay"
            assert stays[0].status.value == "ACTIVE"
            reservation = verify.get(Reservation, reservation_id)
            assert reservation.status.value == "CHECKED_IN"
            room = verify.get(Room, room_id)
            assert room.occupancy_status.value == "occupied"
        finally:
            _delete_room_and_guest(verify, room_id, guest_id)
    finally:
        verify.close()


def test_concurrent_check_out(_database):
    """并发双 Check-out 同一 Stay：1 SUCCESS + 1 × 409，最终一致且无重复审计。"""
    setup = SessionLocal()
    try:
        room_id, guest_id = _create_room_and_guest(setup, "803")
        room = setup.get(Room, room_id)
        payload = ReservationCreate(
            guest_id=guest_id,
            room_id=room_id,
            room_type_id=room.room_type_id,
            check_in_date=today(),
            check_out_date=d(2),
            agreed_total_amount=Decimal("299.00"),
        )
        reservation = booking.create_reservation(setup, payload, None, None)
        _, stay = booking.check_in_reservation(setup, reservation.id, None, None)
        stay_id = stay.id
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def worker():
        session = SessionLocal()
        try:
            def do():
                booking.check_out_stay(session, stay_id, None, None)
                return None

            _capture(do, results, lock)
        finally:
            session.close()

    _run_threads([worker, worker])

    statuses = sorted(r[0] for r in results)
    assert statuses == ["CONFLICT:409", "SUCCESS"], results

    verify = SessionLocal()
    try:
        try:
            stay = verify.get(Stay, stay_id)
            assert stay.status.value == "CHECKED_OUT"
            assert stay.actual_check_out_at is not None
            reservation = verify.get(Reservation, stay.reservation_id)
            assert reservation.status.value == "COMPLETED"
            room = verify.get(Room, room_id)
            assert room.occupancy_status.value == "available"
            assert room.cleaning_status.value == "dirty"
            audit_count = verify.scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(
                    AuditLog.action == "stay.check_out",
                    AuditLog.resource_id == stay_id,
                )
            )
            assert audit_count == 1, "不得产生重复退房审计"
        finally:
            _delete_room_and_guest(verify, room_id, guest_id)
    finally:
        verify.close()


def test_concurrent_business_numbers(_database):
    """并发创建多个 Reservation/Stay：业务单号无重复（Sequence + UNIQUE，REV-04）。"""
    setup = SessionLocal()
    try:
        room_type = setup.scalar(
            select(RoomType).order_by(RoomType.id).limit(1)
        )
        guest = Guest(name="单号并发客人", phone="13600000002")
        setup.add(guest)
        setup.flush()
        rooms = []
        for number in ("810", "811", "812", "813"):
            room = Room(room_number=number, room_type_id=room_type.id, floor=9)
            setup.add(room)
            rooms.append(room)
        setup.commit()
        guest_id = guest.id
        created: list[tuple[int, int, int]] = [
            (guest_id, r.id, r.room_type_id) for r in rooms
        ]
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def worker(guest_id_local, room_id, room_type_id):
        session = SessionLocal()
        try:
            payload = ReservationCreate(
                guest_id=guest_id_local,
                room_id=room_id,
                room_type_id=room_type_id,
                check_in_date=today(),
                check_out_date=d(2),
                agreed_total_amount=Decimal("100.00"),
            )

            def create():
                reservation = booking.create_reservation(
                    session, payload, None, None
                )
                return reservation.reservation_no

            _capture(create, results, lock)
        finally:
            session.close()

    _run_threads([lambda s=spec: worker(*s) for spec in created])

    numbers = [r[1] for r in results if r[0] == "SUCCESS"]
    assert len(numbers) == len(created), results
    assert len(set(numbers)) == len(numbers), "reservation_no 不得重复"
    assert all(RESERVATION_NO_RE.match(n) for n in numbers)

    # 并发 Check-in 生成 stay_no：同样无重复
    setup2 = SessionLocal()
    try:
        reservations = setup2.scalars(
            select(Reservation).where(
                Reservation.room_id.in_([s[1] for s in created])
            )
        ).all()
        res_ids = [r.id for r in reservations]
    finally:
        setup2.close()

    stay_results: list = []
    stay_lock = threading.Lock()

    def stay_worker(res_id):
        session = SessionLocal()
        try:
            def do():
                _, stay = booking.check_in_reservation(session, res_id, None, None)
                return stay.stay_no

            _capture(do, stay_results, stay_lock)
        finally:
            session.close()

    _run_threads([lambda rid=rid: stay_worker(rid) for rid in res_ids])
    stay_numbers = [r[1] for r in stay_results if r[0] == "SUCCESS"]

    cleanup = SessionLocal()
    try:
        try:
            assert len(stay_numbers) == len(res_ids), stay_results
            assert len(set(stay_numbers)) == len(stay_numbers), "stay_no 不得重复"
            assert all(STAY_NO_RE.match(n) for n in stay_numbers)
        finally:
            # 清理顺序：先删 Stay/Reservation（全部房间），再删共享 Guest，最后删房间
            room_ids = [spec[1] for spec in created]
            cleanup.execute(delete(Stay).where(Stay.room_id.in_(room_ids)))
            cleanup.execute(
                delete(Reservation).where(Reservation.room_id.in_(room_ids))
            )
            cleanup.execute(delete(Guest).where(Guest.id == created[0][0]))
            cleanup.execute(delete(Room).where(Room.id.in_(room_ids)))
            cleanup.commit()
    finally:
        cleanup.close()
