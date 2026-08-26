"""Availability（可售性）schemas。"""

from datetime import date

from pydantic import BaseModel


class AvailabilityItem(BaseModel):
    room_id: int
    room_number: str
    room_type_id: int
    room_type_name: str | None = None
    floor: int
    available: bool
    reason: str | None = None


class AvailabilityOut(BaseModel):
    business_date: date
    check_in_date: date
    check_out_date: date
    total: int
    available_count: int
    items: list[AvailabilityItem]
