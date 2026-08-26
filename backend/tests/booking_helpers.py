# -*- coding: utf-8 -*-
"""Booking 测试共用工具。

自动化日期一律基于 Property Business Date（Asia/Shanghai）动态生成，
禁止硬编码固定年月日（REV-03）。
"""

from datetime import date, timedelta

from app.core.business_date import business_date


def today() -> date:
    """业务日期今天（Asia/Shanghai）。"""
    return business_date()


def d(days: int) -> date:
    """业务日期 + N 天。"""
    return business_date() + timedelta(days=days)


def iso(value: date) -> str:
    """date -> YYYY-MM-DD。"""
    return value.isoformat()


def find_room(client, headers, room_number: str) -> dict:
    rooms = client.get(
        "/api/v1/rooms", params={"page_size": 100}, headers=headers
    ).json()["items"]
    return next(r for r in rooms if r["room_number"] == room_number)


def create_guest(
    client,
    headers,
    name="张先生",
    phone="13800138000",
    email="zhang@example.com",
    notes=None,
) -> dict:
    payload: dict = {"name": name, "phone": phone, "email": email}
    if notes is not None:
        payload["notes"] = notes
    resp = client.post("/api/v1/guests", json=payload, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


def create_reservation(
    client,
    headers,
    *,
    room,
    guest_id,
    check_in=None,
    check_out=None,
    source="DIRECT",
    amount="399.00",
    currency="CNY",
    expect=201,
    **kwargs,
) -> dict:
    """创建预订（默认 [today, today+2)）；expect 用于断言非 201 的用例。"""
    payload = {
        "guest_id": guest_id,
        "room_id": room["id"],
        "room_type_id": room["room_type_id"],
        "check_in_date": iso(check_in if check_in is not None else today()),
        "check_out_date": iso(check_out if check_out is not None else d(2)),
        "source": source,
        "agreed_total_amount": amount,
        "currency": currency,
        **kwargs,
    }
    resp = client.post("/api/v1/reservations", json=payload, headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


def check_in(client, headers, reservation_id: int, expect=200):
    resp = client.post(
        f"/api/v1/reservations/{reservation_id}/check-in", headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def check_out(client, headers, stay_id: int, expect=200):
    resp = client.post(
        f"/api/v1/stays/{stay_id}/check-out", headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()
