"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  BookingsOut,
  BusinessInventoryOut,
  BusinessProcurementOut,
  BusinessRoomsOut,
  ForecastOut,
  HousekeepingOut,
  MaintenanceOut,
  OperationsOverviewOut,
  RoomMovesOut,
} from "@/lib/api/types";
import { businessDate } from "@/lib/booking";
import {
  comparisonModeForPreset,
  DEFAULT_PRESET,
  presetRange,
  validateAnalyticsRange,
  type AnalyticsPresetKey,
  type AnalyticsRange,
} from "@/lib/analytics";
import { useUser } from "@/components/app-shell";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";
import DateSelector from "./date-selector";
import OverviewTab from "./overview-tab";
import RoomsBookingsTab from "./rooms-bookings-tab";
import OperationsTab from "./operations-tab";
import InventoryProcurementTab from "./inventory-procurement-tab";

type TabKey = "overview" | "rooms-bookings" | "operations" | "inventory-procurement";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "总览" },
  { key: "rooms-bookings", label: "客房与预订" },
  { key: "operations", label: "运营效率" },
  { key: "inventory-procurement", label: "库存与采购" },
];

interface DataBundle {
  overview?: OperationsOverviewOut;
  bookings?: BookingsOut;
  forecast?: ForecastOut;
  housekeeping?: HousekeepingOut;
  maintenance?: MaintenanceOut;
  roomMoves?: RoomMovesOut;
  rooms?: BusinessRoomsOut;
  inventory?: BusinessInventoryOut;
  procurement?: BusinessProcurementOut;
}

interface FetchState {
  key: string;
  data: DataBundle | null;
  error: ApiError | null;
}

function resolveRange(
  preset: AnalyticsPresetKey,
  customFrom: string,
  customTo: string,
): AnalyticsRange | null {
  if (preset === "custom") {
    if (!customFrom || !customTo) return null;
    return { from: customFrom, to: customTo };
  }
  return presetRange(preset, businessDate());
}

/** /analytics 主视图（§43-§45）：Date Selector + 四 Tab + 权限域分离 */
export default function AnalyticsView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(
    () => new Set(user?.permissions ?? []),
    [user],
  );
  const canOps = permissions.has("analytics:operations_read");
  const canBiz = permissions.has("analytics:business_read");

  const [preset, setPreset] = useState<AnalyticsPresetKey>(DEFAULT_PRESET);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [compare, setCompare] = useState(false);
  const [tab, setTab] = useState<TabKey>("overview");
  const [reloadKey, setReloadKey] = useState(0);
  const [fetchState, setFetchState] = useState<FetchState>({ key: "", data: null, error: null });

  const range = useMemo(
    () => resolveRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );
  const rangeError = range
    ? validateAnalyticsRange(range.from, range.to, businessDate())
    : preset === "custom"
      ? "请选择开始与结束日期"
      : null;

  const requestKey = `${tab}|${range?.from ?? ""}|${range?.to ?? ""}|${compare}|${reloadKey}`;
  const loading = fetchState.key !== requestKey;

  useEffect(() => {
    if (!range || rangeError) return;
    let cancelled = false;
    // D1：按用户所选 preset 发送 comparison_mode（上一周期区间计算由 Backend 权威完成）
    const params = {
      from: range.from,
      to: range.to,
      compare,
      comparison_mode: comparisonModeForPreset(preset),
    };
    const bundle: DataBundle = {};
    const jobs: Promise<void>[] = [];

    if (tab === "overview") {
      if (canOps) {
        jobs.push(api.analytics.operationsOverview(params).then((d) => {
          bundle.overview = d;
        }));
      }
      if (canBiz) {
        jobs.push(api.analytics.businessRooms(params).then((d) => {
          bundle.rooms = d;
        }));
        jobs.push(api.analytics.businessInventory(params).then((d) => {
          bundle.inventory = d;
        }));
        jobs.push(api.analytics.businessProcurement(params).then((d) => {
          bundle.procurement = d;
        }));
      }
    } else if (tab === "rooms-bookings") {
      if (canOps) {
        jobs.push(api.analytics.operationsBookings(params).then((d) => {
          bundle.bookings = d;
        }));
        jobs.push(api.analytics.forecast().then((d) => {
          bundle.forecast = d;
        }));
      }
      if (canBiz) {
        jobs.push(api.analytics.businessRooms(params).then((d) => {
          bundle.rooms = d;
        }));
      }
    } else if (tab === "operations") {
      if (canOps) {
        jobs.push(api.analytics.operationsHousekeeping(params).then((d) => {
          bundle.housekeeping = d;
        }));
        jobs.push(api.analytics.operationsMaintenance(params).then((d) => {
          bundle.maintenance = d;
        }));
        jobs.push(api.analytics.operationsRoomMoves(params).then((d) => {
          bundle.roomMoves = d;
        }));
      }
    } else if (tab === "inventory-procurement") {
      if (canBiz) {
        jobs.push(api.analytics.businessInventory(params).then((d) => {
          bundle.inventory = d;
        }));
        jobs.push(api.analytics.businessProcurement(params).then((d) => {
          bundle.procurement = d;
        }));
      }
    }

    Promise.all(jobs)
      .then(() => {
        if (cancelled) return;
        setFetchState({ key: requestKey, data: bundle, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.kind === "unauthorized") {
          router.replace("/login");
          return;
        }
        setFetchState({
          key: requestKey,
          data: null,
          error:
            err instanceof ApiError ? err : new ApiError("unknown", null, "加载失败"),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    tab,
    preset,
    range?.from,
    range?.to,
    compare,
    reloadKey,
    canOps,
    canBiz,
    range,
    rangeError,
    requestKey,
    router,
  ]);

  if (!canOps && !canBiz) {
    return <Forbidden text="无权限访问经营分析" />;
  }

  const retry = () => {
    setReloadKey((k) => k + 1);
  };

  const visibleTabs = TABS.filter((t) => {
    if (t.key === "operations") return canOps;
    if (t.key === "inventory-procurement") return canBiz;
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">经营分析</h1>
        <p className="text-xs text-gray-400">数据截至业务日期当天之前（Actual）</p>
      </div>

      <DateSelector
        preset={preset}
        onPresetChange={setPreset}
        customFrom={customFrom}
        customTo={customTo}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
        rangeError={rangeError}
        compare={compare}
        onCompareChange={setCompare}
        range={range}
      />

      <div role="tablist" aria-label="分析视图" className="flex flex-wrap gap-1 border-b border-gray-200">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px rounded-t-md border-b-2 px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${
              tab === t.key
                ? "border-gray-900 text-gray-900"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {rangeError ? (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-6 text-center text-sm text-amber-800"
          role="alert"
        >
          {rangeError}
        </div>
      ) : loading ? (
        <Loading text="正在加载经营分析…" />
      ) : fetchState.error ? (
        <ErrorView
          message={fetchState.error.message}
          offline={fetchState.error.kind === "network"}
          onRetry={retry}
        />
      ) : (
        (() => {
          const data = fetchState.data;
          switch (tab) {
            case "overview":
              return (
                <OverviewTab
                  overview={canOps ? (data?.overview ?? null) : null}
                  rooms={canBiz ? (data?.rooms ?? null) : null}
                  inventory={canBiz ? (data?.inventory ?? null) : null}
                  procurement={canBiz ? (data?.procurement ?? null) : null}
                />
              );
            case "rooms-bookings":
              return (
                <RoomsBookingsTab
                  bookings={canOps ? (data?.bookings ?? null) : null}
                  forecast={canOps ? (data?.forecast ?? null) : null}
                  rooms={canBiz ? (data?.rooms ?? null) : null}
                />
              );
            case "operations":
              return (
                <OperationsTab
                  housekeeping={canOps ? (data?.housekeeping ?? null) : null}
                  maintenance={canOps ? (data?.maintenance ?? null) : null}
                  roomMoves={canOps ? (data?.roomMoves ?? null) : null}
                />
              );
            case "inventory-procurement":
              return (
                <InventoryProcurementTab
                  inventory={canBiz ? (data?.inventory ?? null) : null}
                  procurement={canBiz ? (data?.procurement ?? null) : null}
                />
              );
          }
        })()
      )}
    </div>
  );
}
