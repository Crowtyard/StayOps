"""Maintenance Work Order schemas（Sprint 5）。

PII 规则（Sprint 5 §30）：MaintenanceWorkOrder 不关联 Guest / Reservation / Stay，
不保存 Guest name / phone / email / reservation amount / Guest notes；
响应不含任何 Guest PII 与预订数据。
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.maintenance import (
    MaintenanceCategory,
    MaintenanceSeverity,
    MaintenanceSource,
    MaintenanceWorkOrderStatus,
)
from app.models.room import CleaningStatus, OccupancyStatus, UnavailabilitySource


class MaintenanceWorkOrderOut(BaseModel):
    """工单响应。null 字段经 response_model_exclude_none 以键缺失呈现。"""

    id: int
    work_order_no: str
    room_id: int
    room_number: str
    room_occupancy_status: OccupancyStatus
    room_cleaning_status: CleaningStatus
    category: MaintenanceCategory
    severity: MaintenanceSeverity
    status: MaintenanceWorkOrderStatus
    source: MaintenanceSource
    blocks_room: bool
    title: str
    description: str | None = None
    reported_by_user_id: int | None = None
    reporter_name: str | None = None
    assigned_to_user_id: int | None = None
    assignee_name: str | None = None
    verified_by_user_id: int | None = None
    resolution_notes: str | None = None
    verification_notes: str | None = None
    started_at: datetime | None = None
    resolved_at: datetime | None = None
    verified_at: datetime | None = None
    completed_at: datetime | None = None
    cancelled_at: datetime | None = None
    created_by: int | None = None
    updated_by: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class MaintenanceWorkOrderCreate(BaseModel):
    """创建工单（报修）。severity 与 blocks_room 相互独立（Sprint 5 §7）：
    CRITICAL 不自动等于 blocks_room=true。"""

    room_id: int
    category: MaintenanceCategory
    severity: MaintenanceSeverity = MaintenanceSeverity.MEDIUM
    blocks_room: bool = False
    source: MaintenanceSource = MaintenanceSource.MANUAL
    title: str = Field(..., min_length=1, max_length=200)
    description: str | None = Field(None, max_length=2000)


class MaintenanceWorkOrderUpdate(BaseModel):
    """PATCH：仅基础字段编辑；status / blocks_room 不得经 PATCH 修改。

    - strict schema：未知字段（含 status）422；空 payload 422
    - blocks_room 创建后不可修改（阻断语义由创建时决定，
      如需改变阻断语义请取消后重新报修，保持审计清晰）
    """

    model_config = ConfigDict(extra="forbid")

    category: MaintenanceCategory | None = None
    severity: MaintenanceSeverity | None = None
    title: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = Field(None, max_length=2000)

    @model_validator(mode="after")
    def _reject_empty(self) -> "MaintenanceWorkOrderUpdate":
        if not self.model_fields_set:
            raise ValueError("至少提供一个可更新字段")
        return self


class MaintenanceAssigneeOut(BaseModel):
    """可派单候选人（仅员工身份信息，不含任何 Guest PII）。"""

    id: int
    display_name: str
    username: str


class MaintenanceAssign(BaseModel):
    """派单 / 改派：必须指定在职用户。"""

    assigned_to_user_id: int


class MaintenanceResolve(BaseModel):
    """提交解决（可附维修结果说明）。"""

    resolution_notes: str | None = Field(None, max_length=2000)


class MaintenanceVerify(BaseModel):
    """验收通过（可附验收说明）。"""

    verification_notes: str | None = Field(None, max_length=2000)


class MaintenanceRework(BaseModel):
    """验收不通过（返工原因说明）。"""

    verification_notes: str | None = Field(None, max_length=2000)
