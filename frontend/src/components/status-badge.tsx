import type { CleaningStatus, OccupancyStatus } from "@/lib/api/types";
import { CLEANING_META, OCCUPANCY_META, type StatusMeta } from "@/lib/status";

/** 状态徽标：文字 + 颜色双通道 */
export function StatusBadge({ meta }: { meta: StatusMeta }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.badge}`}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export function OccupancyBadge({ status }: { status: OccupancyStatus }) {
  return <StatusBadge meta={OCCUPANCY_META[status]} />;
}

export function CleaningBadge({ status }: { status: CleaningStatus }) {
  return <StatusBadge meta={CLEANING_META[status]} />;
}
