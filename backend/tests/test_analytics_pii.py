# -*- coding: utf-8 -*-
"""S8 PII 测试（§60）：Analytics API payload 不含 Guest / Supplier 联系信息。

禁止：guest name / phone / contact / guest notes；Supplier phone / notes。
允许：room number、item code、supplier name（业务分析必要）。
"""

import json

from tests.analytics_helpers import build_golden, d, get_analytics, iso

ALL_PATHS = (
    "operations/overview",
    "operations/bookings",
    "operations/housekeeping",
    "operations/maintenance",
    "operations/room-moves",
    "business/rooms",
    "business/inventory",
    "business/procurement",
)

# 黄金数据集中的可辨识 PII 标记值（§60 扫描）
GUEST_NAME = "黄金测试客一"
GUEST_PHONE = "13900000001"
GUEST_NOTES = "金色数据集备注一"
SUPPLIER_PHONE = "13800138888"

FORBIDDEN_KEYS = ("guest_name", "phone", "guest_notes", "contact")


def test_analytics_payloads_no_pii(client, db, admin_headers):
    build_golden(client, db, admin_headers)
    params = {"from": iso(d(-6)), "to": iso(d(0))}
    for path in ALL_PATHS:
        payload = get_analytics(client, admin_headers, path, params)
        text = json.dumps(payload, ensure_ascii=False)
        assert GUEST_NAME not in text, f"{path} 泄漏 guest name"
        assert GUEST_PHONE not in text, f"{path} 泄漏 guest phone"
        assert GUEST_NOTES not in text, f"{path} 泄漏 guest notes"
        assert SUPPLIER_PHONE not in text, f"{path} 泄漏 supplier phone"
        # 键名层面禁止 PII 字段
        def walk_keys(value):
            if isinstance(value, dict):
                for key, v in value.items():
                    lowered = key.lower()
                    assert not any(f in lowered for f in FORBIDDEN_KEYS), (
                        f"{path} 含 PII 键 {key}"
                    )
                    walk_keys(v)
            elif isinstance(value, list):
                for v in value:
                    walk_keys(v)
        walk_keys(payload)

    # forecast 同样扫描
    forecast = get_analytics(client, admin_headers, "forecast")
    text = json.dumps(forecast, ensure_ascii=False)
    assert GUEST_NAME not in text and GUEST_PHONE not in text
    assert SUPPLIER_PHONE not in text
    # supplier name 允许出现（业务分析必要，§36）
    assert "泉城黄金供应商" in json.dumps(
        get_analytics(client, admin_headers, "business/procurement", params),
        ensure_ascii=False,
    )
