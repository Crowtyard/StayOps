# -*- coding: utf-8 -*-
"""E2E 测试状态准备：将 Analytics E2E 明确创建的库存流水与收货单时间回填到昨天。

Safety（Sprint 8 QA D2，RELEASE BLOCKER 修复）：
- 只允许数据库名 == stayops_test（解析实际连接目标，拒绝前不执行任何写入；
  不使用 setdefault 作为安全边界——DATABASE_URL 缺失即拒绝）。
- 只修改调用方显式传入的 StockMovement / GoodsReceipt ID（禁止整表 UPDATE）。
- 每个 ID 必须存在且类型匹配；全部校验通过后在同一事务内更新并 commit；
  任意校验失败 rollback 全部 + 非零退出（不允许 best effort / partial update）。
- 无产品后门：不提供生产 API / 路由；不支持开发库；不改动 StockMovement
  正式产品不可变语义（这是 test-only 历史时间回填，供 Analytics Actual E2E 使用）。

用法（由 analytics-helpers.ts 调用；也可手工）：
    .venv\\Scripts\\python.exe e2e\\setup_backdate_procurement.py \
        --receipt-id 1 --movement-id 2 --movement-id 3
"""

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

PROPERTY_UTC_OFFSET = timezone(timedelta(hours=8), name="Asia/Shanghai")

TEST_DATABASE_NAME = "stayops_test"


def database_name_from_url(url: str) -> str:
    """解析实际连接目标的 database name（D2.1）。"""
    parsed = urlparse(url)
    if parsed.scheme not in ("postgresql", "postgresql+psycopg2", "postgres"):
        raise SystemExit(f"无法解析 DATABASE_URL（scheme={parsed.scheme!r}）")
    name = (parsed.path or "").lstrip("/")
    if not name:
        raise SystemExit("DATABASE_URL 缺少数据库名")
    return name


def validate_database_name(name: str) -> None:
    """只允许正式 E2E 测试库 stayops_test；其它（含开发库 stayops）在写前拒绝。"""
    if name != TEST_DATABASE_NAME:
        raise SystemExit(
            f"拒绝执行：目标数据库为 {name!r}，仅允许测试库 {TEST_DATABASE_NAME!r}。"
            "本脚本是 Analytics E2E 专用历史时间回填，禁止作用于开发/生产数据库。"
        )


def resolve_target_time() -> datetime:
    """回填目标时刻：昨天 09:30（Asia/Shanghai）。"""
    now = datetime.now(PROPERTY_UTC_OFFSET)
    return (now - timedelta(days=1)).replace(
        hour=9, minute=30, second=0, microsecond=0
    )


def backdate_targets(conn, receipt_ids, movement_ids, target_time) -> dict:
    """校验并回填显式指定的测试行（D2.2/D2.3）。

    - 每个 ID 必须存在（SELECT ... FOR UPDATE），缺失即抛错（调用方回滚）。
    - 只 UPDATE 传入 ID 对应的行；未传入的行（unrelated）保持不变。
    返回 {"receipts": n, "movements": n}。
    """
    if not receipt_ids and not movement_ids:
        raise SystemExit("拒绝执行：未提供任何目标 ID（--receipt-id / --movement-id 至少一个）")

    receipts = {}
    if receipt_ids:
        rows = conn.execute(
            text(
                "SELECT id FROM goods_receipts WHERE id = ANY(:ids) FOR UPDATE"
            ),
            {"ids": list(receipt_ids)},
        ).all()
        receipts = {r.id for r in rows}
        missing = set(receipt_ids) - receipts
        if missing:
            raise SystemExit(
                f"校验失败：goods_receipts 中不存在 ID {sorted(missing)}；"
                "回滚全部，不执行任何更新"
            )

    movements = {}
    if movement_ids:
        rows = conn.execute(
            text(
                "SELECT id FROM stock_movements WHERE id = ANY(:ids) FOR UPDATE"
            ),
            {"ids": list(movement_ids)},
        ).all()
        movements = {r.id for r in rows}
        missing = set(movement_ids) - movements
        if missing:
            raise SystemExit(
                f"校验失败：stock_movements 中不存在 ID {sorted(missing)}；"
                "回滚全部，不执行任何更新"
            )

    if receipt_ids:
        conn.execute(
            text(
                "UPDATE goods_receipts SET received_at = :t, created_at = :t "
                "WHERE id = ANY(:ids)"
            ),
            {"t": target_time, "ids": list(receipt_ids)},
        )
    if movement_ids:
        conn.execute(
            text(
                "UPDATE stock_movements SET created_at = :t WHERE id = ANY(:ids)"
            ),
            {"t": target_time, "ids": list(movement_ids)},
        )
    return {"receipts": len(receipt_ids), "movements": len(movement_ids)}


def main(argv=None, connect=None) -> None:
    parser = argparse.ArgumentParser(
        description="Analytics E2E 专用历史时间回填（仅 stayops_test，仅显式 ID）"
    )
    parser.add_argument("--receipt-id", action="append", type=int, default=[],
                        dest="receipt_ids", metavar="N", help="GoodsReceipt ID（可重复）")
    parser.add_argument("--movement-id", action="append", type=int, default=[],
                        dest="movement_ids", metavar="N", help="StockMovement ID（可重复）")
    args = parser.parse_args(argv)

    # D2.1：解析实际连接目标；缺失或非 stayops_test 一律在写前拒绝（无 setdefault）。
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("拒绝执行：缺少 DATABASE_URL（本脚本不提供默认连接目标）")
    validate_database_name(database_name_from_url(url))

    if not args.receipt_ids and not args.movement_ids:
        raise SystemExit("拒绝执行：未提供任何目标 ID（--receipt-id / --movement-id 至少一个）")

    target_time = resolve_target_time()
    engine = connect() if connect is not None else create_engine(url)
    with engine.begin() as conn:  # 单事务：validate -> update -> commit；异常自动 rollback
        try:
            result = backdate_targets(
                conn, args.receipt_ids, args.movement_ids, target_time
            )
        except SystemExit:
            raise
        except SQLAlchemyError as exc:  # 数据库错误同样整体回滚
            raise SystemExit(f"回填失败（已回滚）：{exc}") from exc
    print(
        f"OK receipts={result['receipts']} movements={result['movements']} "
        f"-> {target_time.isoformat()}"
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # 任何意外错误：非零退出，绝不部分成功
        print(f"FATAL: {exc}", file=sys.stderr)
        sys.exit(1)
