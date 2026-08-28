# -*- coding: utf-8 -*-
"""Room Move 并发测试（Sprint 6 §32，P0）。

真实 PostgreSQL 并发（两线程 + 独立 Session 真实提交，不经 conftest 外层事务）：
- Move A -> 205 vs Move B -> 205：exactly one success（目标房只有一个 ACTIVE Stay）
- Move -> 205 vs Create CONFIRMED Reservation -> 205：no double allocation
- Move vs Checkout 同一 Stay：no torn state（不允许 CHECKED_OUT + open assignment）
- Reservation update vs active-room allocation：exactly one allocation wins

多轮 repeated stress，报告 rounds / successes / expected 409s /
unexpected 500s / deadlocks（任何一轮出现 ERROR 即失败）。
"""

import threading
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import delete, select

from app.database import SessionLocal
from app.models import (
    Guest,
    HousekeepingTask,
    Reservation,
    Room,
    RoomType,
    Stay,
    StayRoomAssignment,
)
from app.schemas.reservation import ReservationCreate, ReservationUpdate
from app.schemas.stay import RoomMoveCreate
from app.models.stay_assignment import RoomMoveReason
from app.services import booking
from app.services import room_move as room_move_service
from tests.booking_helpers import d, today

STRESS_ROUNDS = 10


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


def _run_threads(targets: list, timeout: float = 90) -> None:
    threads = [threading.Thread(target=t) for t in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=timeout)
        assert not thread.is_alive(), "线程未在限时内结束"


def _new_room(db, number: str) -> int:
    room_type = db.scalar(select(RoomType).order_by(RoomType.id).limit(1))
    room = Room(room_number=number, room_type_id=room_type.id, floor=9)
    db.add(room)
    return room


def _new_guest(db, name: str) -> int:
    guest = Guest(name=name, phone="13600000009")
    db.add(guest)
    db.flush()
    return guest.id


def _make_stay(db, room_number: str, name: str) -> tuple[int, int, int, int]:
    """在提交会话中创建 房间+客人+预订+入住，返回 (stay_id, room_id, guest_id, reservation_id)。"""
    room = _new_room(db, room_number)
    db.flush()
    guest_id = _new_guest(db, name)
    reservation = Reservation(
        reservation_no=f"RSVCONC-{room_number}",
        guest_id=guest_id,
        room_id=room.id,
        room_type_id=room.room_type_id,
        check_in_date=today(),
        check_out_date=d(2),
        status="CHECKED_IN",
        source="DIRECT",
        agreed_total_amount=Decimal("299.00"),
        currency="CNY",
    )
    db.add(reservation)
    db.flush()
    stay = Stay(
        stay_no=f"STYCONC-{room_number}",
        reservation_id=reservation.id,
        room_id=room.id,
        status="ACTIVE",
        actual_check_in_at=booking.property_now(),
        planned_check_out_date=d(2),
    )
    db.add(stay)
    db.flush()
    db.add(
        StayRoomAssignment(
            stay_id=stay.id,
            room_id=room.id,
            started_at=stay.actual_check_in_at,
        )
    )
    db.commit()
    return stay.id, room.id, guest_id, reservation.id


def _cleanup(db, room_ids: list[int], guest_ids: list[int]) -> None:
    db.execute(
        delete(HousekeepingTask).where(HousekeepingTask.room_id.in_(room_ids))
    )
    db.execute(
        delete(StayRoomAssignment).where(
            StayRoomAssignment.room_id.in_(room_ids)
        )
    )
    db.execute(delete(Stay).where(Stay.room_id.in_(room_ids)))
    db.execute(delete(Reservation).where(Reservation.room_id.in_(room_ids)))
    for guest_id in set(guest_ids):
        db.execute(delete(Guest).where(Guest.id == guest_id))
    db.execute(delete(Room).where(Room.id.in_(room_ids)))
    db.commit()


def _stress_report(scenario: str, rounds: int, results_per_round: list[list]) -> None:
    """汇总报告：rounds / successes / expected 409s / unexpected 500s / deadlocks。"""
    successes = 0
    conflicts = 0
    errors = 0
    deadlocks = 0
    for results in results_per_round:
        for status, detail in results:
            if status == "SUCCESS":
                successes += 1
            elif status == "CONFLICT:409":
                conflicts += 1
            elif status.startswith("ERROR:"):
                errors += 1
                if "DeadlockDetected" in status or "deadlock" in str(detail).lower():
                    deadlocks += 1
    print(
        f"[S6-STRESS] {scenario}: rounds={rounds} successes={successes} "
        f"expected_409s={conflicts} unexpected_errors={errors} deadlocks={deadlocks}"
    )
    assert errors == 0, f"{scenario}: 出现未预期错误（500 等价），results={results_per_round}"
    assert deadlocks == 0, f"{scenario}: 出现死锁逃逸"


# ---------------------------------------------------------------------------
# P0-1：Move A -> T vs Move B -> T（Sprint 6 §23）
# ---------------------------------------------------------------------------


def test_concurrent_two_moves_same_target(_database):
    """两笔换房抢同一目标房：exactly one success + one 409（repeated stress）。"""
    results_per_round: list[list] = []
    all_room_ids: list[int] = []
    all_guest_ids: list[int] = []

    for idx in range(STRESS_ROUNDS):
        setup = SessionLocal()
        try:
            stay_a, room_a, guest_a, _ = _make_stay(
                setup, f"9{idx:02d}A", f"并发客人A{idx}"
            )
            stay_b, room_b, guest_b, _ = _make_stay(
                setup, f"9{idx:02d}B", f"并发客人B{idx}"
            )
            target = _new_room(setup, f"9{idx:02d}C")
            setup.flush()
            target_id = target.id
            setup.commit()
            all_room_ids += [room_a, room_b, target_id]
            all_guest_ids += [guest_a, guest_b]
        finally:
            setup.close()

        results: list = []
        lock = threading.Lock()

        def worker(stay_id: int, reason: RoomMoveReason):
            session = SessionLocal()
            try:
                def do():
                    room_move_service.move_stay(
                        session,
                        stay_id,
                        RoomMoveCreate(target_room_id=target_id, reason=reason),
                        None,
                        None,
                    )
                    return None

                _capture(do, results, lock)
            finally:
                session.close()

        _run_threads(
            [
                lambda: worker(stay_a, RoomMoveReason.MAINTENANCE),
                lambda: worker(stay_b, RoomMoveReason.UPGRADE),
            ]
        )

        statuses = sorted(r[0] for r in results)
        assert statuses == ["CONFLICT:409", "SUCCESS"], (
            f"round {idx}: {results}"
        )
        results_per_round.append(results)

        # 目标房最终只有一个 ACTIVE Stay / current Assignment
        verify = SessionLocal()
        try:
            stays_on_target = verify.scalars(
                select(Stay).where(
                    Stay.room_id == target_id, Stay.status == "ACTIVE"
                )
            ).all()
            assert len(stays_on_target) == 1, "目标房只能有一个 ACTIVE Stay"
            open_assignments = verify.scalars(
                select(StayRoomAssignment).where(
                    StayRoomAssignment.room_id == target_id,
                    StayRoomAssignment.ended_at.is_(None),
                )
            ).all()
            assert len(open_assignments) == 1
        finally:
            verify.close()

    _stress_report("move-vs-move-same-target", STRESS_ROUNDS, results_per_round)

    cleanup = SessionLocal()
    try:
        _cleanup(cleanup, all_room_ids, all_guest_ids)
    finally:
        cleanup.close()


# ---------------------------------------------------------------------------
# P0-2：Move -> T vs Create CONFIRMED Reservation -> T（Sprint 6 §22）
# ---------------------------------------------------------------------------


def test_concurrent_move_vs_create_reservation(_database):
    """换房 vs 新建重叠 CONFIRMED 预订抢同一目标房：
    exactly one logical allocation wins，绝不 double allocation（repeated stress）。"""
    results_per_round: list[list] = []
    all_room_ids: list[int] = []
    all_guest_ids: list[int] = []

    for idx in range(STRESS_ROUNDS):
        setup = SessionLocal()
        try:
            stay_id, source_id, guest_id, _ = _make_stay(
                setup, f"9{idx:02d}D", f"并发换房客人{idx}"
            )
            target = _new_room(setup, f"9{idx:02d}E")
            setup.flush()
            target_id = target.id
            reservation_guest = _new_guest(setup, f"并发订房客人{idx}")
            setup.commit()
            all_room_ids += [source_id, target_id]
            all_guest_ids += [guest_id, reservation_guest]
        finally:
            setup.close()

        results: list = []
        lock = threading.Lock()

        def move_worker():
            session = SessionLocal()
            try:
                def do():
                    room_move_service.move_stay(
                        session,
                        stay_id,
                        RoomMoveCreate(
                            target_room_id=target_id,
                            reason=RoomMoveReason.GUEST_REQUEST,
                        ),
                        None,
                        None,
                    )
                    return None

                _capture(do, results, lock)
            finally:
                session.close()

        def reservation_worker():
            session = SessionLocal()
            try:
                target_row = session.get(Room, target_id)
                payload = ReservationCreate(
                    guest_id=reservation_guest,
                    room_id=target_id,
                    room_type_id=target_row.room_type_id,
                    check_in_date=today(),
                    check_out_date=d(2),
                    agreed_total_amount=Decimal("299.00"),
                )

                def do():
                    booking.create_reservation(session, payload, None, None)
                    return None

                _capture(do, results, lock)
            finally:
                session.close()

        _run_threads([move_worker, reservation_worker])

        statuses = sorted(r[0] for r in results)
        assert statuses == ["CONFLICT:409", "SUCCESS"], (
            f"round {idx}: {results}"
        )
        results_per_round.append(results)

        # 最终只能一个逻辑分配赢：目标房要么被 Stay 占用、要么被 CONFIRMED 预订
        verify = SessionLocal()
        try:
            stay_on_target = verify.scalar(
                select(Stay.id).where(
                    Stay.room_id == target_id, Stay.status == "ACTIVE"
                )
            )
            confirmed_on_target = verify.scalar(
                select(Reservation.id).where(
                    Reservation.room_id == target_id,
                    Reservation.status == "CONFIRMED",
                    Reservation.check_in_date < d(2),
                    Reservation.check_out_date > today(),
                )
            )
            assert (stay_on_target is None) != (confirmed_on_target is None), (
                "double allocation 或全部失败"
            )
        finally:
            verify.close()

    _stress_report(
        "move-vs-create-reservation", STRESS_ROUNDS, results_per_round
    )

    cleanup = SessionLocal()
    try:
        _cleanup(cleanup, all_room_ids, all_guest_ids)
    finally:
        cleanup.close()


# ---------------------------------------------------------------------------
# P0-3：Move vs Checkout 同一 Stay（Sprint 6 §21）
# ---------------------------------------------------------------------------


def test_concurrent_move_vs_checkout_same_stay(_database):
    """换房 vs 退房同一 Stay：共享 Stay 行锁，后到事务重新验证状态。

    合法序列（Sprint 6 §21）：
    - Checkout 先赢 -> Move 后到重验证看到 CHECKED_OUT -> 409
    - Move 先赢 -> Checkout 在锁上等待后对已换房 Stay 正常退房（退房关闭
      target 上的 open assignment）
    两种序列都不得出现撕裂状态：CHECKED_OUT stay 必须 0 个 open assignment。
    """
    results_per_round: list[list] = []
    all_room_ids: list[int] = []
    all_guest_ids: list[int] = []

    for idx in range(STRESS_ROUNDS):
        setup = SessionLocal()
        try:
            stay_id, source_id, guest_id, reservation_id = _make_stay(
                setup, f"9{idx:02d}F", f"并发退房客人{idx}"
            )
            target = _new_room(setup, f"9{idx:02d}G")
            setup.flush()
            target_id = target.id
            setup.commit()
            all_room_ids += [source_id, target_id]
            all_guest_ids.append(guest_id)
        finally:
            setup.close()

        results: list = []
        lock = threading.Lock()

        def move_worker():
            session = SessionLocal()
            try:
                def do():
                    room_move_service.move_stay(
                        session,
                        stay_id,
                        RoomMoveCreate(
                            target_room_id=target_id,
                            reason=RoomMoveReason.MAINTENANCE,
                        ),
                        None,
                        None,
                    )
                    return None

                _capture(do, results, lock)
            finally:
                session.close()

        def checkout_worker():
            session = SessionLocal()
            try:
                def do():
                    booking.check_out_stay(session, stay_id, None, None)
                    return None

                _capture(do, results, lock)
            finally:
                session.close()

        _run_threads([move_worker, checkout_worker])

        # Checkout 必须成功（对未退房/已换房 Stay 均合法）；
        # Move 允许 SUCCESS（先换后退）或 409（先退后换被拒）
        statuses = {r[0] for r in results}
        assert "SUCCESS" in statuses, f"round {idx}: {results}"
        assert statuses <= {"SUCCESS", "CONFLICT:409"}, f"round {idx}: {results}"
        move_won = statuses == {"SUCCESS"}
        results_per_round.append(results)

        verify = SessionLocal()
        try:
            stay_row = verify.get(Stay, stay_id)
            open_assignments = verify.scalars(
                select(StayRoomAssignment).where(
                    StayRoomAssignment.stay_id == stay_id,
                    StayRoomAssignment.ended_at.is_(None),
                )
            ).all()
            # 撕裂状态禁令：CHECKED_OUT stay 必须 0 个 open assignment
            assert stay_row.status.value == "CHECKED_OUT"
            assert len(open_assignments) == 0, (
                f"round {idx}: CHECKED_OUT stay 不得有 open assignment"
            )
            reservation_row = verify.get(Reservation, reservation_id)
            assert reservation_row.status.value == "COMPLETED"
            assignments = verify.scalars(
                select(StayRoomAssignment)
                .where(StayRoomAssignment.stay_id == stay_id)
                .order_by(StayRoomAssignment.id)
            ).all()
            if move_won:
                # Move 先赢：历史 = [source closed, target closed]（退房关闭 target）
                assert [a.room_id for a in assignments] == [source_id, target_id]
                assert all(a.ended_at is not None for a in assignments)
            else:
                # Checkout 先赢：历史 = [source closed]，Move 被拒
                assert [a.room_id for a in assignments] == [source_id]
                assert all(a.ended_at is not None for a in assignments)
        finally:
            verify.close()

    _stress_report(
        "move-vs-checkout", STRESS_ROUNDS, results_per_round
    )

    cleanup = SessionLocal()
    try:
        _cleanup(cleanup, all_room_ids, all_guest_ids)
    finally:
        cleanup.close()


# ---------------------------------------------------------------------------
# P0-4：Reservation update vs active-room allocation（Sprint 6 §32）
# ---------------------------------------------------------------------------


def test_concurrent_reservation_update_vs_move(_database):
    """CONFIRMED 预订改期/换房到目标房 vs 换房到同一目标房：
    目标房行锁串行化，exactly one allocation wins（repeated stress）。"""
    results_per_round: list[list] = []
    all_room_ids: list[int] = []
    all_guest_ids: list[int] = []

    for idx in range(STRESS_ROUNDS):
        setup = SessionLocal()
        try:
            stay_id, source_id, guest_id, _ = _make_stay(
                setup, f"9{idx:02d}H", f"并发更新客人{idx}"
            )
            target = _new_room(setup, f"9{idx:02d}I")
            other = _new_room(setup, f"9{idx:02d}J")
            setup.flush()
            target_id, other_id = target.id, other.id
            reservation_guest = _new_guest(setup, f"并发改期客人{idx}")
            # 先在其它房建一笔未来 CONFIRMED 预订（之后并发改到目标房）
            reservation = Reservation(
                reservation_no=f"RSVUPD-{idx:02d}",
                guest_id=reservation_guest,
                room_id=other_id,
                room_type_id=other.room_type_id,
                check_in_date=d(5),
                check_out_date=d(7),
                status="CONFIRMED",
                source="DIRECT",
                agreed_total_amount=Decimal("299.00"),
                currency="CNY",
            )
            setup.add(reservation)
            setup.flush()
            reservation_id = reservation.id
            setup.commit()
            all_room_ids += [source_id, target_id, other_id]
            all_guest_ids += [guest_id, reservation_guest]
        finally:
            setup.close()

        results: list = []
        lock = threading.Lock()

        def move_worker():
            session = SessionLocal()
            try:
                def do():
                    room_move_service.move_stay(
                        session,
                        stay_id,
                        RoomMoveCreate(
                            target_room_id=target_id,
                            reason=RoomMoveReason.OPERATIONAL,
                        ),
                        None,
                        None,
                    )
                    return None

                _capture(do, results, lock)
            finally:
                session.close()

        def update_worker():
            session = SessionLocal()
            try:
                reservation_row = session.scalar(
                    select(Reservation)
                    .where(Reservation.id == reservation_id)
                    .with_for_update()
                )

                def do():
                    booking.update_reservation(
                        session,
                        reservation_row,
                        ReservationUpdate(
                            room_id=target_id,
                            check_in_date=today(),
                            check_out_date=d(2),
                        ),
                        None,
                        None,
                    )
                    return None

                _capture(do, results, lock)
            finally:
                session.close()

        _run_threads([move_worker, update_worker])

        statuses = sorted(r[0] for r in results)
        assert statuses == ["CONFLICT:409", "SUCCESS"], (
            f"round {idx}: {results}"
        )
        results_per_round.append(results)

        verify = SessionLocal()
        try:
            stay_on_target = verify.scalar(
                select(Stay.id).where(
                    Stay.room_id == target_id, Stay.status == "ACTIVE"
                )
            )
            reservation_row = verify.get(Reservation, reservation_id)
            reservation_on_target = (
                reservation_row.room_id == target_id
                and reservation_row.status.value == "CONFIRMED"
                and reservation_row.check_in_date == today()
            )
            assert stay_on_target is None or not reservation_on_target, (
                "目标房双重分配"
            )
            assert (stay_on_target is not None) or reservation_on_target, (
                "目标房无人分配（不应发生）"
            )
        finally:
            verify.close()

    _stress_report(
        "reservation-update-vs-move", STRESS_ROUNDS, results_per_round
    )

    cleanup = SessionLocal()
    try:
        _cleanup(cleanup, all_room_ids, all_guest_ids)
    finally:
        cleanup.close()
