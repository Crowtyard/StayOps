import type { Metadata } from "next";
import MaintenanceReportForm from "@/components/maintenance/report-form";
import type { MaintenanceSource } from "@/lib/api/types";

export const metadata: Metadata = { title: "现场报修" };

export default async function MaintenanceNewPage({
  searchParams,
}: {
  searchParams: Promise<{ room_id?: string; source?: string }>;
}) {
  const params = await searchParams;
  const roomIdRaw = params.room_id;
  const roomId = roomIdRaw ? Number(roomIdRaw) : undefined;
  const sourceRaw = params.source;
  const validSources: MaintenanceSource[] = [
    "MANUAL",
    "FRONT_DESK",
    "HOUSEKEEPING",
    "PRE_OPENING",
  ];
  const source =
    sourceRaw && validSources.includes(sourceRaw as MaintenanceSource)
      ? (sourceRaw as MaintenanceSource)
      : undefined;

  return (
    <MaintenanceReportForm
      prefill={{
        roomId: roomId && !Number.isNaN(roomId) ? roomId : undefined,
        source,
      }}
    />
  );
}
