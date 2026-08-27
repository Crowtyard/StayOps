# -*- coding: utf-8 -*-
"""Housekeeping 并发测试（Sprint 3，真实提交的独立 Session）：

1. Duplicate Active Task：两个并发创建同一脏房任务 → 恰 1 SUCCESS + 1 CONFLICT（409），
   数据库部分唯一索引（uq_housekeeping_tasks_active_room）为最终仲裁。
2. Concurrent Start：两个并发 start 同一 PENDING 任务 → 1 SUCCESS + 1 × 409，
   最终 IN_PROGRESS + 房间 cleaning，无重复审计。
3. Concurrent Inspection Decision：同一 INSPECTION 任务并发 PASS vs REWORK
   → 恰一个成功，最终状态一致（COMPLETED+clean 或 REWORK+rework），
   不允许矛盾状态（如 Task COMPLETED + Room rework）。
4. 业务单号并发：task_no 无重复（Sequence + UNIQUE）。
"""

import re
import threading

from fastapi import HTTPException
from sqlalchemy import delete, func, select

from app.database import SessionLocal
from app.models import (
    AuditLog,
    HousekeepingTask,
    Room,
    RoomType,
)
from app.schemas.housekeeping import HousekeepingTaskCreate
from app.services import housekeeping

TASK_NO_RE = re.compile(r"^HKT\d{8}-\d{4,}$")


def _create_dirty_room(db, room_number: str) -> int:
    room_type = db.scalar(select(RoomType).order_by(RoomType.id).limit(1))
    room = Room(
        room_number=room_number,
        room_type_id=room_type.id,
        floor=9,
        cleaning_status="dirty",
    )
    db.add(room)
    db.commit()
    return room.id


def _delete_room(db, room_id: int) -> None:
    db.execute(delete(HousekeepingTask).where(HousekeepingTask.room_id == room_id))
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


def test_concurrent_duplicate_active_task(_database):
    """两次并发创建同一脏房任务 → 恰 1 SUCCESS + 1 CONFLICT；库中恰一个进行中任务。"""
    setup = SessionLocal()
    try:
        room_id = _create_dirty_room(setup, "701")
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def worker():
        session = SessionLocal()
        try:
            payload = HousekeepingTaskCreate(room_id=room_id)

            def create():
                housekeeping.create_manual_task(session, payload, None, None)
                return None

            _capture(create, results, lock)
        finally:
            session.close()

    _run_threads([worker, worker])

    statuses = sorted(r[0] for r in results)
    assert statuses == ["CONFLICT:409", "SUCCESS"], results
    conflict_detail = next(r[1] for r in results if r[0] == "CONFLICT:409")
    assert "已有进行中的保洁任务" in conflict_detail

    verify = SessionLocal()
    try:
        try:
            count = verify.scalar(
                select(func.count())
                .select_from(HousekeepingTask)
                .where(HousekeepingTask.room_id == room_id)
            )
            assert count == 1, "数据库最终应只有 1 条任务"
        finally:
            _delete_room(verify, room_id)
    finally:
        verify.close()


def test_concurrent_start(_database):
    """并发 start 同一 PENDING 任务 → 1 SUCCESS + 1 × 409；最终一致、无重复审计。"""
    setup = SessionLocal()
    try:
        room_id = _create_dirty_room(setup, "702")
        payload = HousekeepingTaskCreate(room_id=room_id)
        task = housekeeping.create_manual_task(setup, payload, None, None)
        task_id = task.id
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def worker():
        session = SessionLocal()
        try:
            def do():
                housekeeping.start_task(session, task_id, None, None)
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
            task = verify.get(HousekeepingTask, task_id)
            assert task.status.value == "IN_PROGRESS"
            assert task.started_at is not None
            room = verify.get(Room, room_id)
            assert room.cleaning_status.value == "cleaning"
            audit_count = verify.scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(
                    AuditLog.action == "housekeeping.start",
                    AuditLog.resource_id == task_id,
                )
            )
            assert audit_count == 1, "不得产生重复开始审计"
        finally:
            _delete_room(verify, room_id)
    finally:
        verify.close()


def test_concurrent_inspection_decision(_database):
    """INSPECTION 任务并发 PASS vs REWORK → 恰一个成功；
    最终状态一致（COMPLETED+clean 或 REWORK+rework），不允许矛盾组合。"""
    setup = SessionLocal()
    try:
        room_id = _create_dirty_room(setup, "703")
        payload = HousekeepingTaskCreate(room_id=room_id)
        task = housekeeping.create_manual_task(setup, payload, None, None)
        task_id = task.id
        housekeeping.start_task(setup, task_id, None, None)
        housekeeping.submit_inspection(setup, task_id, None, None)
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def pass_worker():
        session = SessionLocal()
        try:
            def do():
                housekeeping.pass_task(session, task_id, None, None)
                return None

            _capture(do, results, lock)
        finally:
            session.close()

    def rework_worker():
        session = SessionLocal()
        try:
            def do():
                housekeeping.rework_task(session, task_id, None, None)
                return None

            _capture(do, results, lock)
        finally:
            session.close()

    _run_threads([pass_worker, rework_worker])

    statuses = sorted(r[0] for r in results)
    assert statuses == ["CONFLICT:409", "SUCCESS"], results

    verify = SessionLocal()
    try:
        try:
            task = verify.get(HousekeepingTask, task_id)
            room = verify.get(Room, room_id)
            if task.status.value == "COMPLETED":
                assert room.cleaning_status.value == "clean"
            elif task.status.value == "REWORK":
                assert room.cleaning_status.value == "rework"
            else:
                raise AssertionError(f"非法终态：{task.status.value}")
            # 不允许矛盾状态（COMPLETED+rework / REWORK+clean）
            assert not (
                task.status.value == "COMPLETED"
                and room.cleaning_status.value == "rework"
            )
            assert not (
                task.status.value == "REWORK"
                and room.cleaning_status.value == "clean"
            )
            # 审计数量：pass + rework 合计恰好 1 条成功事件
            audit_count = verify.scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(
                    AuditLog.resource_id == task_id,
                    AuditLog.action.in_(
                        ["housekeeping.pass", "housekeeping.rework"]
                    ),
                )
            )
            assert audit_count == 1, "验房决定审计必须恰好一条"
        finally:
            _delete_room(verify, room_id)
    finally:
        verify.close()


def test_concurrent_task_numbers(_database):
    """并发创建多个任务 → task_no 无重复（Sequence + UNIQUE 约束）。"""
    setup = SessionLocal()
    try:
        room_ids = [
            _create_dirty_room(setup, number) for number in ("710", "711", "712", "713")
        ]
    finally:
        setup.close()

    results: list = []
    lock = threading.Lock()

    def worker(room_id):
        session = SessionLocal()
        try:
            payload = HousekeepingTaskCreate(room_id=room_id)

            def create():
                task = housekeeping.create_manual_task(session, payload, None, None)
                return task.task_no

            _capture(create, results, lock)
        finally:
            session.close()

    _run_threads([lambda rid=rid: worker(rid) for rid in room_ids])

    numbers = [r[1] for r in results if r[0] == "SUCCESS"]
    assert len(numbers) == len(room_ids), results
    assert len(set(numbers)) == len(numbers), "task_no 不得重复"
    assert all(TASK_NO_RE.match(n) for n in numbers)

    cleanup = SessionLocal()
    try:
        for room_id in room_ids:
            cleanup.execute(
                delete(HousekeepingTask).where(HousekeepingTask.room_id == room_id)
            )
            cleanup.execute(delete(Room).where(Room.id == room_id))
        cleanup.commit()
    finally:
        cleanup.close()
