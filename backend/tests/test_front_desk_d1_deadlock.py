# -*- coding: utf-8 -*-
"""D1 修复测试（Kun Fast QA Blocking Defect + Fast Review 收窄分类）：

并发 Double Booking 时，PostgreSQL 排他约束（daterange EXCLUDE USING gist）
的检查可能让两事务互相等待 ShareLock，PostgreSQL 中止其一并报
DeadlockDetected（SQLSTATE 40P01）。修复前该 OperationalError 逃逸为 500。

错误分类（唯一权威）：
- 23P01 exclusion_violation        → 409（既有 Reservation 排他约束冲突）
- 40P01 deadlock_detected          → 409（D1）
- 40001 serialization_failure      → 409（事务序列化冲突）
- 其它任何 OperationalError（57014 query_canceled、无 pgcode、连接故障、
  库不可用、无关超时等）→ rollback 后原样 re-raise，不得转换/吞掉

覆盖：
- 确定性单测：commit / flush 处 40P01、40001 → 409 Double Booking 语义；
  57014 与无 pgcode 的 OperationalError → 原异常传播 + 事务已回滚
- 多轮真实并发双订（每轮独立房间）：每轮必须 1 SUCCESS + 1 CONFLICT:409，
  任何一轮出现 ERROR（500 等价）即失败
"""

import threading
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError

from app.database import SessionLocal
from app.models import Guest, Reservation, Room, RoomType
from app.schemas.reservation import ReservationCreate
from app.services import booking
from tests.booking_helpers import d, today
from tests.test_booking_concurrency import (
    _capture,
    _create_room_and_guest,
    _delete_room_and_guest,
    _run_threads,
)

_DOUBLE_BOOKING_DETAIL = "该房间在所选日期区间已被预订"


class _FakeDBAPIError(Exception):
    """模拟 DBAPI 层错误（仅携带 pgcode，与 psycopg2 真实错误暴露方式一致）。

    psycopg2 的 pgcode 是 C 级 member descriptor，手工构造的异常实例上为 None
    （仅连接抛出的真实错误会填充）；测试用本类作为 OperationalError.orig。
    """

    def __init__(self, pgcode: str | None):
        super().__init__(f"fake dbapi error {pgcode}")
        self.pgcode = pgcode


def _deadlock_error() -> OperationalError:
    return OperationalError("COMMIT", {}, _FakeDBAPIError("40P01"))


def _serialization_error() -> OperationalError:
    return OperationalError("COMMIT", {}, _FakeDBAPIError("40001"))


def _canceled_error() -> OperationalError:
    return OperationalError("COMMIT", {}, _FakeDBAPIError("57014"))


def _no_pgcode_error() -> OperationalError:
    return OperationalError("COMMIT", {}, _FakeDBAPIError(None))


def _seed_room_guest_in(db, room_number: str) -> tuple[int, int, int]:
    """在 fixture 会话（savepoint）内创建专用房间与客人，随用例自动回滚。"""
    room_type = db.scalar(select(RoomType).order_by(RoomType.id).limit(1))
    room = Room(room_number=room_number, room_type_id=room_type.id, floor=9)
    guest = Guest(name=f"并发客人{room_number}", phone="13600000001")
    db.add_all([room, guest])
    db.flush()
    return room.id, guest.id, room_type.id


def _setup_room_guest_committed(room_number: str) -> tuple[int, int, int]:
    """真实提交会话创建专用房间与客人（并发轮次需要跨连接可见）。"""
    setup = SessionLocal()
    try:
        room_id, guest_id = _create_room_and_guest(setup, room_number)
        room_type_id = setup.get(Room, room_id).room_type_id
        return room_id, guest_id, room_type_id
    finally:
        setup.close()


def _payload(room_id, guest_id, room_type_id) -> ReservationCreate:
    return ReservationCreate(
        guest_id=guest_id,
        room_id=room_id,
        room_type_id=room_type_id,
        check_in_date=today(),
        check_out_date=d(2),
        agreed_total_amount=Decimal("299.00"),
    )


# ---------------------------------------------------------------------------
# 确定性映射测试（不再依赖概率复现）
# ---------------------------------------------------------------------------


def test_deadlock_at_commit_maps_to_409(_database, db, monkeypatch):
    """commit 阶段 DeadlockDetected(40P01) → 409 Double Booking，绝不 500。"""
    room_id, guest_id, room_type_id = _seed_room_guest_in(db, "9101")
    monkeypatch.setattr(
        booking, "check_room_availability", lambda *a, **k: (True, None)
    )
    monkeypatch.setattr(db, "commit", lambda: (_ for _ in ()).throw(_deadlock_error()))
    with pytest.raises(HTTPException) as exc_info:
        booking.create_reservation(
            db, _payload(room_id, guest_id, room_type_id), None, None
        )
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == _DOUBLE_BOOKING_DETAIL


def test_deadlock_at_flush_maps_to_409(_database, db, monkeypatch):
    """flush（INSERT 排他约束检查）阶段 40P01 → 409 Double Booking。"""
    room_id, guest_id, room_type_id = _seed_room_guest_in(db, "9102")
    monkeypatch.setattr(
        booking, "check_room_availability", lambda *a, **k: (True, None)
    )
    monkeypatch.setattr(db, "flush", lambda: (_ for _ in ()).throw(_deadlock_error()))
    with pytest.raises(HTTPException) as exc_info:
        booking.create_reservation(
            db, _payload(room_id, guest_id, room_type_id), None, None
        )
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == _DOUBLE_BOOKING_DETAIL


def test_serialization_failure_maps_to_409(_database, db, monkeypatch):
    """40001 serialization_failure（同属并发仲裁）→ 409，绝不 500。"""
    room_id, guest_id, room_type_id = _seed_room_guest_in(db, "9103")
    monkeypatch.setattr(
        booking, "check_room_availability", lambda *a, **k: (True, None)
    )
    monkeypatch.setattr(
        db, "commit", lambda: (_ for _ in ()).throw(_serialization_error())
    )
    with pytest.raises(HTTPException) as exc_info:
        booking.create_reservation(
            db, _payload(room_id, guest_id, room_type_id), None, None
        )
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == _DOUBLE_BOOKING_DETAIL


def test_query_canceled_operational_error_re_raised(_database, db, monkeypatch):
    """57014 query_canceled 不是业务并发冲突：原样 re-raise + 事务已回滚。"""
    room_id, guest_id, room_type_id = _seed_room_guest_in(db, "9104")
    monkeypatch.setattr(
        booking, "check_room_availability", lambda *a, **k: (True, None)
    )
    monkeypatch.setattr(
        db, "commit", lambda: (_ for _ in ()).throw(_canceled_error())
    )
    with pytest.raises(OperationalError) as exc_info:
        booking.create_reservation(
            db, _payload(room_id, guest_id, room_type_id), None, None
        )
    # 原始异常原样传播（未转换为 409/422/400，未吞掉）
    assert exc_info.value is not None
    assert getattr(getattr(exc_info.value, "orig", None), "pgcode", None) == "57014"
    # rollback 已验证：flush 插入的 Reservation 已随 savepoint 回滚
    count = db.scalar(
        select(func.count())
        .select_from(Reservation)
        .where(Reservation.room_id == room_id)
    )
    assert count == 0


def test_operational_error_without_pgcode_re_raised(_database, db, monkeypatch):
    """无 pgcode 的 OperationalError（连接故障等）：rollback 后原样 re-raise。"""
    room_id, guest_id, room_type_id = _seed_room_guest_in(db, "9106")
    monkeypatch.setattr(
        booking, "check_room_availability", lambda *a, **k: (True, None)
    )
    monkeypatch.setattr(
        db, "commit", lambda: (_ for _ in ()).throw(_no_pgcode_error())
    )
    with pytest.raises(OperationalError):
        booking.create_reservation(
            db, _payload(room_id, guest_id, room_type_id), None, None
        )
    count = db.scalar(
        select(func.count())
        .select_from(Reservation)
        .where(Reservation.room_id == room_id)
    )
    assert count == 0


def test_update_deadlock_maps_to_409(_database, db, monkeypatch):
    """改期/换房重检排他约束时 40P01 → 409 Double Booking。"""
    room_id, guest_id, room_type_id = _seed_room_guest_in(db, "9105")
    reservation = Reservation(
        reservation_no="RSV-D1-9105",
        guest_id=guest_id,
        room_id=room_id,
        room_type_id=room_type_id,
        check_in_date=d(5),
        check_out_date=d(7),
        source="DIRECT",
        agreed_total_amount=Decimal("299.00"),
        currency="CNY",
    )
    db.add(reservation)
    db.flush()
    monkeypatch.setattr(
        booking, "check_room_availability", lambda *a, **k: (True, None)
    )
    monkeypatch.setattr(db, "commit", lambda: (_ for _ in ()).throw(_deadlock_error()))
    from app.schemas.reservation import ReservationUpdate

    with pytest.raises(HTTPException) as exc_info:
        booking.update_reservation(
            db,
            reservation,
            ReservationUpdate(check_in_date=d(1)),
            None,
            None,
        )
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == _DOUBLE_BOOKING_DETAIL


# ---------------------------------------------------------------------------
# 多轮真实并发双订：任何一轮不得出现 500（ERROR）
# ---------------------------------------------------------------------------


def test_concurrent_double_booking_rounds_never_500(_database, monkeypatch):
    """25 轮两线程并发抢同一房间同一日期：
    每轮 = 1 SUCCESS + 1 CONFLICT:409（含死锁仲裁轮），绝不出现 ERROR/500。
    """
    rounds = 25
    created: list[tuple[int, int]] = []
    check_in_date, check_out_date = today(), d(2)

    for idx in range(rounds):
        room_number = f"92{idx:02d}"
        room_id, guest_id, room_type_id = _setup_room_guest_committed(room_number)
        created.append((room_id, guest_id))

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

                _capture(create, results, lock)
            finally:
                session.close()

        _run_threads([worker, worker])

        statuses = sorted(r[0] for r in results)
        assert statuses == ["CONFLICT:409", "SUCCESS"], (
            f"round {idx}: 1 SUCCESS + 1 CONFLICT 期望失败，实际 {results}"
        )
        # 成功者之外，失败者必须是 Double Booking 语义（23P01 或 40P01 仲裁）
        conflict_detail = next(
            r[1] for r in results if r[0] == "CONFLICT:409"
        )
        assert conflict_detail == _DOUBLE_BOOKING_DETAIL, conflict_detail

    # 清理专用房间/客人（避免污染其它用例）
    setup = SessionLocal()
    try:
        for room_id, guest_id in created:
            _delete_room_and_guest(setup, room_id, guest_id)
    finally:
        setup.close()
