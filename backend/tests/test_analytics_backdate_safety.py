# -*- coding: utf-8 -*-
"""S8 QA D2：E2E Backdate 脚本安全测试（Release Blocker 修复）。

覆盖（D2.6）：
- DATABASE_URL -> stayops（开发库）→ 写前拒绝、零连接、零修改
- DATABASE_URL 缺失 → 拒绝（不再使用 setdefault 默认值）
- 无目标 ID → 拒绝
- 非法 ID → 校验失败回滚（不执行任何更新）
- 显式有效 ID → 只更新指定行；unrelated 行保持不变
"""

import importlib.util
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.core.business_date import PROPERTY_UTC_OFFSET
from app.models import GoodsReceipt, InventoryItem, StockMovement

SCRIPT_PATH = (
    Path(__file__).resolve().parents[2] / "frontend" / "e2e" / "setup_backdate_procurement.py"
)


def _load_script():
    spec = importlib.util.spec_from_file_location("setup_backdate_procurement", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


script = _load_script()


def _refuse_connect():
    """连接桩：一旦被调用即失败——证明拒绝发生在任何数据库访问之前。"""

    def _connect():
        raise AssertionError("不允许连接数据库：拒绝必须发生在任何写入/连接之前")

    return _connect


def _target_time() -> datetime:
    now = datetime.now(PROPERTY_UTC_OFFSET)
    return (now - timedelta(days=1)).replace(hour=9, minute=30, second=0, microsecond=0)


def test_database_name_from_url_parses():
    assert script.database_name_from_url(
        "postgresql+psycopg2://stayops:change-me@localhost:5432/stayops_test"
    ) == "stayops_test"
    assert script.database_name_from_url(
        "postgresql+psycopg2://stayops:change-me@localhost:5432/stayops"
    ) == "stayops"


def test_refuse_dev_database_before_any_write(monkeypatch):
    """DATABASE_URL -> stayops（开发库）：写前拒绝、零连接、零修改。"""
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg2://stayops:change-me@localhost:5432/stayops")
    with pytest.raises(SystemExit) as exc:
        script.main(argv=["--movement-id", "1"], connect=_refuse_connect())
    assert "stayops" in str(exc.value)
    assert "stayops_test" in str(exc.value)


def test_refuse_unknown_database_before_any_write(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg2://u:p@localhost:5432/other_db")
    with pytest.raises(SystemExit) as exc:
        script.main(argv=["--receipt-id", "1"], connect=_refuse_connect())
    assert "other_db" in str(exc.value)


def test_refuse_missing_database_url(monkeypatch):
    """DATABASE_URL 缺失：拒绝（不使用 setdefault 默认值作为安全边界，D2.1）。"""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(SystemExit) as exc:
        script.main(argv=["--movement-id", "1"], connect=_refuse_connect())
    assert "DATABASE_URL" in str(exc.value)


def test_refuse_no_target_ids(monkeypatch):
    """无目标 ID：拒绝（D2.2 require at least one explicit target ID）。"""
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg2://stayops:change-me@localhost:5432/stayops_test")
    with pytest.raises(SystemExit) as exc:
        script.main(argv=[], connect=_refuse_connect())
    assert "目标 ID" in str(exc.value)


def test_invalid_id_rollback_no_updates(db):
    """非法 ID：校验失败即抛错，不执行任何更新（D2.3 rollback all）。"""
    conn = db.get_bind()
    target = _target_time()
    with pytest.raises(SystemExit) as exc:
        script.backdate_targets(conn, [999_999_999], [999_999_999], target)
    assert "不存在" in str(exc.value)
    # 校验失败后没有任何行被修改（连合法表都没有变化）
    count = db.execute(
        script_text_count(target)
    ).scalar_one()
    assert count == 0


def script_text_count(target: datetime):
    from sqlalchemy import func, select

    return select(func.count(StockMovement.id)).where(StockMovement.created_at == target)


def test_only_specified_rows_updated_unrelated_preserved(db):
    """显式 ID：只更新指定行；unrelated 行与收货单保持不变（D2.2/D2.6）。"""
    from sqlalchemy import func, select

    conn = db.get_bind()
    target = _target_time()

    item = InventoryItem(
        item_code="DBG-SAFE-ITEM", name="安全测试物资", category="OTHER",
        base_unit="个", minimum_stock=0, target_stock=0,
    )
    db.add(item)
    db.flush()

    m1 = StockMovement(
        movement_no="DBG-SMV-1", item_id=item.id, location_id=1,
        movement_type="INITIAL", quantity=1, created_by_user_id=None,
    )
    m2 = StockMovement(
        movement_no="DBG-SMV-2", item_id=item.id, location_id=1,
        movement_type="INITIAL", quantity=1, created_by_user_id=None,
    )
    db.add_all([m1, m2])
    db.flush()

    result = script.backdate_targets(conn, [], [m1.id], target)
    assert result == {"receipts": 0, "movements": 1}

    db.expire_all()
    m1 = db.get(StockMovement, m1.id)
    m2 = db.get(StockMovement, m2.id)
    assert m1.created_at == target
    assert m2.created_at != target  # unrelated 行保持不变

    # unrelated GoodsReceipt 同样不受影响（无 receipt ID 传入）
    receipt_count = db.execute(
        select(func.count(GoodsReceipt.id)).where(GoodsReceipt.received_at == target)
    ).scalar_one()
    assert receipt_count == 0
