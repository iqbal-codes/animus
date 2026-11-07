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

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-[12px] border border-[var(--border-subtle)] bg-card p-[18px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs leading-[1.4] text-text-secondary">{kpi.label}</span>
        <Icon aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
      </div>
      <span className="text-[28px] leading-[1.4] font-medium tracking-[-0.8px] text-foreground">
        {kpi.value}
      </span>
      <span className={cn("text-[11px] leading-[1.4]", INK_TEXT[kpi.ink ?? "secondary"])}>
        {kpi.description}
      </span>
    </div>
  );
}
