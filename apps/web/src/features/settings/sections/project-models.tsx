import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Boxes, ChevronDown, Sparkles } from "lucide-react";
import {
  BUILTIN_TIER_KEYS,
  defaultTiers,
  formatTierLabel,
  ModelTiersCard,
  orderedTierKeys,
  type TiersMap,
  useHarnessCatalogs,
} from "./tier-editor";

type PipelineRoleKey = "triage" | "planner" | "builder" | "qa" | "reviewer" | "reflector";
type RolesMap = Record<PipelineRoleKey, string>;

const PIPELINE_ROLE_META: Array<{
  role: PipelineRoleKey;
  description: string;
  budget: string;
  defaultTier: "small" | "medium" | "large";
}> = [
  {
    role: "triage",
    description: "Repository-grounded backlog evaluation & admission",
    budget: "2m / 3m",
    defaultTier: "medium",
  },
  {
    role: "planner",
    description: "Draft refinement, spec decomposition & dependency planning",
    budget: "15m / 20m",
    defaultTier: "large",
  },
  {
    role: "builder",
    description: "Primary implementation agent",
    budget: "20m / 25m",
    defaultTier: "medium",
  },
  {
    role: "qa",
    description: "Verification & regression checks",
    budget: "15m / 20m",
    defaultTier: "small",
  },
  {
    role: "reviewer",
    description: "Independent code review & diff impact analysis",
    budget: "15m / 20m",
    defaultTier: "large",
  },
  {
    role: "reflector",
    description: "Post-lap lesson synthesis & codebase rules curation",
    budget: "15m / 20m",
    defaultTier: "large",
  },
];

const DEFAULT_ROLES: RolesMap = {
  triage: "medium",
  planner: "large",
  builder: "medium",
  qa: "small",
  reviewer: "large",
  reflector: "large",
};

export function ProjectModelsSection({
  currentProjectId,
}: {
  currentProjectId?: string | null;
} = {}) {
  const [baseBranch, setBaseBranch] = useState("main");
  const [concurrencyLimit, setConcurrencyLimit] = useState(2);
  const [tiers, setTiers] = useState<TiersMap>(() => defaultTiers("pi", "default"));
  const [roles, setRoles] = useState<RolesMap>(DEFAULT_ROLES);

  const { catalogByProvider, loadingProviders } = useHarnessCatalogs(
    Object.values(tiers).map((t) => t.provider),
  );

  // Load project settings on mount or when currentProjectId changes
  useEffect(() => {
    const url = currentProjectId
      ? `/api/v1/settings/project?projectId=${encodeURIComponent(currentProjectId)}`
      : "/api/v1/settings/project";

    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.models) return;
        const conc = data.models.concurrencyLimit ?? 2;
        const branch = data.models.baseBranch || "main";

        const loadedTiers: TiersMap = {};
        if (data.models.tiers && typeof data.models.tiers === "object") {
          for (const [k, raw] of Object.entries(
            data.models.tiers as Record<
              string,
              { provider?: string; model?: string; effort?: string }
            >,
          )) {
            if (!raw) continue;
            loadedTiers[k] = {
              provider: raw.provider || "pi",
              model: raw.model || "default",
              effort: raw.effort || (k === "small" ? "medium" : "high"),
            };
          }
        }
        for (const builtin of BUILTIN_TIER_KEYS) {
          if (!loadedTiers[builtin]) {
            loadedTiers[builtin] = defaultTiers()[builtin]!;
          }
        }

        const nextRoles: RolesMap = { ...DEFAULT_ROLES };
        if (data.models.roles && typeof data.models.roles === "object") {
          for (const meta of PIPELINE_ROLE_META) {
            const candidate = (data.models.roles as Record<string, unknown>)[meta.role];
            if (typeof candidate === "string" && loadedTiers[candidate]) {
              nextRoles[meta.role] = candidate;
            }
          }
        }

        setBaseBranch(branch);
        setConcurrencyLimit(conc);
        setTiers(loadedTiers);
        setRoles(nextRoles);
      })
      .catch(() => {});
  }, [currentProjectId]);

  const saveModels = (updates: {
    baseBranch?: string;
    concurrencyLimit?: number;
    tiers?: TiersMap;
    roles?: RolesMap;
  }) => {
    const nextBranch = updates.baseBranch ?? baseBranch;
    const nextConcurrency = updates.concurrencyLimit ?? concurrencyLimit;
    const nextTiers = updates.tiers ?? tiers;
    const nextRoles = updates.roles ?? roles;

    const url = currentProjectId
      ? `/api/v1/settings/project?projectId=${encodeURIComponent(currentProjectId)}`
      : "/api/v1/settings/project";

    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          baseBranch: nextBranch,
          concurrencyLimit: nextConcurrency,
          tiers: nextTiers,
          roles: nextRoles,
        },
      }),
    }).catch(() => {});
  };

  const rolesByTier: Record<string, string[]> = {};
  for (const tierKey of Object.keys(tiers)) {
    rolesByTier[tierKey] = [];
  }
  for (const meta of PIPELINE_ROLE_META) {
    const t = roles[meta.role];
    if (!rolesByTier[t]) rolesByTier[t] = [];
    rolesByTier[t]!.push(meta.role);
  }

  const inUseCustomTiers = new Set(
    Object.values(roles).filter((t) => !(BUILTIN_TIER_KEYS as readonly string[]).includes(t)),
  );
  const availableTierKeys = orderedTierKeys(tiers);

  return (
    <div className="flex flex-col gap-8">
      {/* Repository Branch & Concurrency */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Boxes className="size-4 text-text-secondary" />
            <h3 className="text-base font-medium leading-[1.4] text-foreground">
              Repository branch &amp; concurrency
            </h3>
          </div>
          <span className="text-xs text-text-secondary">Configured in .animus/config.yaml</span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* Default Base Branch */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Default base branch
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Target branch for isolated worktrees and PRs (worktree.baseBranch).
              </span>
            </div>
            <input
              id="settings-base-branch"
              type="text"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              onBlur={() => {
                const clean = baseBranch.trim() || "main";
                setBaseBranch(clean);
                saveModels({ baseBranch: clean });
              }}
              className="h-[38px] w-[240px] rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-3 font-mono text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
            />
          </div>

          {/* Concurrency Limit */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Concurrency limit
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Maximum worktrees active at once for this project.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-concurrency-limit"
                value={concurrencyLimit}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setConcurrencyLimit(val);
                  saveModels({ concurrencyLimit: val });
                }}
                className="h-[38px] w-[240px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                <option value={1}>1 worktree</option>
                <option value={2}>2 worktrees</option>
                <option value={4}>4 worktrees</option>
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Per-Tier Harness, Model & Effort Section */}
      <ModelTiersCard
        title="Model tiers"
        subtitle="Mix harnesses, models, and effort per tier (inherits user defaults)"
        tiers={tiers}
        rolesByTier={rolesByTier}
        inUseCustomTiers={inUseCustomTiers}
        defaultNewProvider={tiers.large?.provider || tiers.medium?.provider || "pi"}
        catalogByProvider={catalogByProvider}
        loadingProviders={loadingProviders}
        onChangeTiers={(nextTiers) => {
          const nextRoles = { ...roles };
          for (const meta of PIPELINE_ROLE_META) {
            if (!nextTiers[nextRoles[meta.role]]) {
              nextRoles[meta.role] = meta.defaultTier;
            }
          }
          setTiers(nextTiers);
          setRoles(nextRoles);
          saveModels({ tiers: nextTiers, roles: nextRoles });
        }}
        onDraftTierModel={(tierKey, val) => {
          setTiers((prev) => ({
            ...prev,
            [tierKey]: { ...prev[tierKey]!, model: val },
          }));
        }}
      />

      {/* Pipeline Role Routing Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-text-secondary" />
            <h3 className="text-base font-medium leading-[1.4] text-foreground">Role routing</h3>
          </div>
          <span className="text-xs text-text-secondary">
            Assign a model tier to each Animus pipeline step
          </span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {PIPELINE_ROLE_META.map((meta) => {
            const selectedTier = roles[meta.role];
            const binding = tiers[selectedTier] ?? tiers.medium;
            return (
              <div
                key={meta.role}
                className="flex flex-wrap items-center justify-between gap-4 py-3.5"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="default"
                      className="font-mono text-xs font-semibold text-foreground"
                    >
                      {meta.role}
                    </Badge>
                    <Badge variant="outline" className="font-mono text-[11px] text-text-secondary">
                      {meta.budget}
                    </Badge>
                  </div>
                  <span className="text-[13px] leading-[1.45] text-text-secondary">
                    {meta.description}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {binding && (
                    <span className="hidden font-mono text-xs text-text-secondary md:inline">
                      {binding.provider} · {binding.model} ({binding.effort})
                    </span>
                  )}
                  <div className="relative shrink-0">
                    <select
                      aria-label={`${meta.role} role tier`}
                      value={selectedTier}
                      onChange={(e) => {
                        const nextRoles: RolesMap = { ...roles, [meta.role]: e.target.value };
                        setRoles(nextRoles);
                        saveModels({ roles: nextRoles });
                      }}
                      className="h-[34px] w-[140px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-8 pl-2.5 text-xs font-medium text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
                    >
                      {availableTierKeys.map((tierKey) => (
                        <option key={tierKey} value={tierKey}>
                          {formatTierLabel(tierKey)}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-text-secondary"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
