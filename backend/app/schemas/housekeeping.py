"""Housekeeping Task schemas（Sprint 3）。

PII 规则：HousekeepingTask 不关联 Guest / Reservation，
响应不含任何 Guest 身份/联系方式与预订数据。
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, model_validator

from app.models.housekeeping import (
    HousekeepingTaskPriority,
    HousekeepingTaskSource,
    HousekeepingTaskStatus,
)


class HousekeepingTaskOut(BaseModel):
    """任务响应。assigned_to 为 null（未派单）时省略 assignee_* 字段。"""

    id: int
    task_no: str
    room_id: int
    room_number: str
    status: HousekeepingTaskStatus
    priority: HousekeepingTaskPriority
    source: HousekeepingTaskSource
    assigned_to_user_id: int | None = None
    assignee_name: str | None = None
    notes: str | None = None
    started_at: datetime | None = None
    submitted_for_inspection_at: datetime | None = None
    completed_at: datetime | None = None
    cancelled_at: datetime | None = None
    created_by: int | None = None
    updated_by: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class HousekeepingTaskCreate(BaseModel):
    """手动创建任务（source 固定 MANUAL；仅允许对 dirty 房间）。"""

    room_id: int
    priority: HousekeepingTaskPriority = HousekeepingTaskPriority.NORMAL
    notes: str | None = None


class HousekeepingAssigneeOut(BaseModel):
    """可派单候选人（仅员工身份信息，不含任何 Guest PII）。"""

    id: int
    display_name: str
    username: str


class HousekeepingTaskUpdate(BaseModel):
    """PATCH：仅 assignment / priority / notes；status 不得经 PATCH 修改。

    - assigned_to_user_id 传 null = 取消派单（unassign）
    - strict schema：未知字段（含 status）422；空 payload 422
    """

    model_config = ConfigDict(extra="forbid")

    priority: HousekeepingTaskPriority | None = None
    assigned_to_user_id: int | None = None
    notes: str | None = None

    @model_validator(mode="after")
    def _reject_empty(self) -> "HousekeepingTaskUpdate":
        # 以字段是否出现在请求体为准（assigned_to_user_id 显式传 null = 取消派单，
        # 属于合法 payload，不得误判为空）
        if not self.model_fields_set:
            raise ValueError("至少提供一个可更新字段")
        return self
