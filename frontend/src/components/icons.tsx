/**
 * 内联 SVG 图标（无外部图标库依赖），24×24，stroke 风格。
 */

interface IconProps {
  className?: string;
}

function Svg({
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className ?? "size-5"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconHome({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 10.8 12 3l9 7.8" />
      <path d="M5.2 9.6V21h13.6V9.6" />
      <path d="M9.6 21v-6.4h4.8V21" />
    </Svg>
  );
}

export function IconRooms({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1" />
    </Svg>
  );
}

export function IconTag({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 10.6V3h7.6l9.5 9.5a1.6 1.6 0 0 1 0 2.3l-5.3 5.3a1.6 1.6 0 0 1-2.3 0L3 10.6Z" />
      <circle cx="7.5" cy="7.5" r="1.3" />
    </Svg>
  );
}

export function IconUsers({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c.6-3.4 2.8-5 5.5-5s4.9 1.6 5.5 5" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M15.5 15.4c2.3.2 4 1.5 4.7 4.6" />
    </Svg>
  );
}

export function IconShield({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 3 5 5.8v5.4c0 4.4 3 8.1 7 9.8 4-1.7 7-5.4 7-9.8V5.8L12 3Z" />
      <path d="m9.2 11.8 2 2 3.6-3.8" />
    </Svg>
  );
}

export function IconAudit({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M7 3h10a1 1 0 0 1 1 1v16.4a.6.6 0 0 1-1 .5L13 18l-4 2.9a.6.6 0 0 1-1-.5V4a1 1 0 0 1 1-1Z" />
      <path d="M9.5 8h5M9.5 12h5M9.5 16h2.5" />
    </Svg>
  );
}

export function IconMenu({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </Svg>
  );
}

export function IconX({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconLogout({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M14 4h-8a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8" />
      <path d="M10 12h10M17 8.5 20.5 12 17 15.5" />
    </Svg>
  );
}

export function IconRefresh({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 3v4.5h-4.5" />
    </Svg>
  );
}

export function IconAlert({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" />
      <path d="M12 9.5v4.5M12 16.8v.2" />
    </Svg>
  );
}

export function IconBuilding({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16" />
      <path d="M14 9h5a1 1 0 0 1 1 1v11" />
      <path d="M2 21h20" />
      <path d="M7.5 7.5h3M7.5 11h3M7.5 14.5h3M16.5 13h.1M16.5 16.5h.1" />
    </Svg>
  );
}

export function IconPlus({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconPencil({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17l-1 3Z" />
      <path d="m13.5 6.5 3 3" />
    </Svg>
  );
}

export function IconTrash({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 7h16M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
      <path d="M6.5 7 7.3 20a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9L17.5 7" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

export function IconChevronDown({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function IconEye({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </Svg>
  );
}

export function IconBooking({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3.5" y="5" width="17" height="16" rx="1.5" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
      <path d="m9 13.5 2 2 4-4" />
    </Svg>
  );
}

export function IconStay({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 20v-7.5a1.5 1.5 0 0 1 1.5-1.5h13a1.5 1.5 0 0 1 1.5 1.5V20" />
      <path d="M3 20h18M4 15.5v-3a1.5 1.5 0 0 1 1.5-1.5H8a1.5 1.5 0 0 1 1.5 1.5v3" />
      <path d="M16 13v-3a1.5 1.5 0 0 1 1.5-1.5h1A1.5 1.5 0 0 1 20 10v3" />
    </Svg>
  );
}

export function IconSearch({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </Svg>
  );
}

export function IconBack({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Svg>
  );
}

export function IconCleaning({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="m7 3 3 3 2-3 2 3 3-3v7a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V3Z" />
      <path d="M10 13v3a4 4 0 0 1-4 4h-1a1 1 0 0 0-1 1v.5a1 1 0 0 0 1 1h2.5" />
      <path d="M7 13v3a4 4 0 0 0 4 4h3" />
    </Svg>
  );
}

export function IconDesk({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 4a6 6 0 0 0-6 6v1.5a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5.5a2 2 0 0 0-2-2V10a6 6 0 0 0-6-6Z" />
      <path d="M10 21v-4a2 2 0 0 1 4 0v4" />
      <path d="M8 8.5h.01M12 8.5h.01M16 8.5h.01" />
    </Svg>
  );
}

export function IconMaintenance({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.6L3 17.6V21h3.4l5.7-5.7a4.5 4.5 0 0 0 5.6-6l-3.4 3.4-2.8-.7-.7-2.8 3.9-3.9Z" />
      <path d="M17.5 3.5a2.4 2.4 0 0 1 3 3" />
    </Svg>
  );
}

/** Sprint 7：库存（货架 + 箱） */
export function IconInventory({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 9.5 12 4l9 5.5v5L12 20l-9-5.5v-5Z" />
      <path d="M3 9.5 12 15l9-5.5" />
      <path d="M12 15v5" />
    </Svg>
  );
}

/** Sprint 7：采购（购物袋） */
export function IconProcurement({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M5.2 8.5h13.6l-1.3 10a2 2 0 0 1-2 1.7H8.5a2 2 0 0 1-2-1.7l-1.3-10Z" />
      <path d="M8.8 8.5V7a3.2 3.2 0 0 1 6.4 0v1.5" />
    </Svg>
  );
}

/** Sprint 8：经营分析（仪表盘） */
export function IconAnalytics({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 19V9" />
      <path d="M10 19V5" />
      <path d="M16 19v-7" />
      <path d="M22 19H2" />
    </Svg>
  );
}

/** Sprint 8：趋势上升 */
export function IconTrendUp({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 17 9 11l4 4 7-8" />
      <path d="M15 7h5v5" />
    </Svg>
  );
}

/** Sprint 8：趋势下降 */
export function IconTrendDown({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 7l6 6 4-4 7 8" />
      <path d="M15 17h5v-5" />
    </Svg>
  );
}

/** Sprint 8：趋势持平 */
export function IconTrendFlat({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 12h18" />
    </Svg>
  );
}
