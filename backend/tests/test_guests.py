# -*- coding: utf-8 -*-
"""Guest CRUD 测试：创建 / 列表 / 详情 / PATCH；401/403/404/422；search（name OR phone）。"""

from tests.booking_helpers import create_guest


def test_create_guest(client, admin_headers):
    resp = client.post(
        "/api/v1/guests",
        json={
            "name": "李女士",
            "phone": "13912345678",
            "email": "li@example.com",
            "notes": "偏好高层",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "李女士"
    assert body["phone"] == "13912345678"
    assert body["email"] == "li@example.com"
    assert body["notes"] == "偏好高层"
    assert body["id"] > 0


def test_create_guest_requires_name_422(client, admin_headers):
    resp = client.post(
        "/api/v1/guests", json={"phone": "13912345678"}, headers=admin_headers
    )
    assert resp.status_code == 422


def test_get_guest_and_404(client, admin_headers):
    guest = create_guest(client, admin_headers, name="王先生")
    resp = client.get(f"/api/v1/guests/{guest['id']}", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["name"] == "王先生"
    assert (
        client.get("/api/v1/guests/99999", headers=admin_headers).status_code
        == 404
    )


def test_patch_guest(client, admin_headers):
    guest = create_guest(client, admin_headers)
    resp = client.patch(
        f"/api/v1/guests/{guest['id']}",
        json={"phone": "13700000000", "notes": "已更新备注"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["phone"] == "13700000000"
    assert body["notes"] == "已更新备注"
    assert body["name"] == "张先生"  # 未提供字段不变


def test_guest_search_by_name(client, admin_headers):
    create_guest(client, admin_headers, name="赵钱孙")
    create_guest(client, admin_headers, name="李周吴")
    resp = client.get(
        "/api/v1/guests", params={"search": "钱孙"}, headers=admin_headers
    )
    assert resp.status_code == 200
    names = [g["name"] for g in resp.json()["items"]]
    assert "赵钱孙" in names
    assert "李周吴" not in names


def test_guest_search_by_phone(client, admin_headers):
    create_guest(client, admin_headers, name="甲客人", phone="18611112222")
    create_guest(client, admin_headers, name="乙客人", phone="18633334444")
    resp = client.get(
        "/api/v1/guests", params={"search": "1111"}, headers=admin_headers
    )
    assert resp.status_code == 200
    names = [g["name"] for g in resp.json()["items"]]
    assert "甲客人" in names
    assert "乙客人" not in names


def test_guest_list_pagination(client, admin_headers):
    for i in range(3):
        create_guest(client, admin_headers, name=f"批量客人{i}")
    page1 = client.get(
        "/api/v1/guests", params={"page": 1, "page_size": 2}, headers=admin_headers
    ).json()
    assert len(page1["items"]) == 2
    assert page1["total"] >= 3
    page2 = client.get(
        "/api/v1/guests", params={"page": 2, "page_size": 2}, headers=admin_headers
    ).json()
    assert len(page2["items"]) >= 1
    ids1 = {g["id"] for g in page1["items"]}
    ids2 = {g["id"] for g in page2["items"]}
    assert ids1.isdisjoint(ids2)


def test_guest_endpoints_require_auth(client):
    assert client.get("/api/v1/guests").status_code == 401
    assert (
        client.post("/api/v1/guests", json={"name": "x"}).status_code == 401
    )


def test_guest_endpoints_require_permission(client, make_user, token_for):
    make_user("hk_guest", role_names=["HOUSEKEEPING"])
    h = {"Authorization": f"Bearer {token_for('hk_guest')}"}
    assert client.get("/api/v1/guests", headers=h).status_code == 403
    assert (
        client.post("/api/v1/guests", json={"name": "x"}, headers=h).status_code
        == 403
    )
    assert client.patch("/api/v1/guests/1", json={}, headers=h).status_code == 403
