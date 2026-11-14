import {
  ChartNoAxesColumn,
  Cpu,
  GitPullRequest,
  Layers,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import type { KpiIcon, KpiModel } from "./jobs-model";
import { INK_TEXT } from "./tone";

const KPI_ICONS: Record<KpiIcon, LucideIcon> = {
  layers: Layers,
  cpu: Cpu,
  "git-pull-request": GitPullRequest,
  "chart-no-axes-column": ChartNoAxesColumn,
  wallet: Wallet,
};

/** KPI tile (`cXSJU` and siblings): 12 radius, 18 inset, 12 gap, elevation-1 surface. */
export function KpiCard({ kpi }: { kpi: KpiModel }) {
  const Icon = KPI_ICONS[kpi.icon];
  const isTextualValue = kpi.value.trim().length > 6 && !/^[\d\s/$.,+\-%]+$/.test(kpi.value.trim());

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-hidden rounded-[12px] border border-[var(--border-subtle)] bg-[var(--elevation-1-surface)] p-3 sm:gap-3 sm:p-[17px]">
      <div className="flex items-center justify-between gap-2">
        <span
          title={kpi.label}
          className="line-clamp-1 min-w-0 text-xs leading-[1.4] text-text-secondary"
        >
          {kpi.label}
        </span>
        <Icon aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
      </div>
      <div className="flex min-h-[31px] min-w-0 items-center sm:min-h-[39px]">
        <span
          title={kpi.value}
          className={cn(
            "block min-w-0 truncate font-medium",
            isTextualValue
              ? "text-[15px] leading-[1.35] tracking-[-0.2px] text-text-secondary sm:text-[17px]"
              : "text-[22px] leading-[1.4] tracking-[-0.8px] text-foreground tabular-nums sm:text-[28px]",
          )}
        >
          {kpi.value}
        </span>
      </div>
      <span
        title={kpi.description}
        className={cn("line-clamp-1 text-[11px] leading-[1.4]", INK_TEXT[kpi.ink ?? "secondary"])}
      >
        {kpi.description}
      </span>
    </div>
  );
}
