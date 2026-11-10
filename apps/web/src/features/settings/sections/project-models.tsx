import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Boxes, ChevronDown, Sparkles } from "lucide-react";

interface ModelTier {
  id: string;
  name: string;
  key: string;
  roles: string;
  provider: string;
  model: string;
  effort: string;
}

const TIERS: ModelTier[] = [
  {
    id: "small",
    name: "Small",
    key: "small",
    roles: "Default for: qa, auditor",
    provider: "pi",
    model: "claude-haiku-4-5",
    effort: "medium",
  },
  {
    id: "medium",
    name: "Medium",
    key: "medium",
    roles: "Default for: builder, investigator, simplifier, triage",
    provider: "pi",
    model: "claude-sonnet-4-6",
    effort: "high",
  },
  {
    id: "large",
    name: "Large",
    key: "large",
    roles: "Default for: planner, reflector, reviewer",
    provider: "pi",
    model: "claude-opus-4-6",
    effort: "xhigh",
  },
];

interface RoleRouting {
  id: string;
  role: string;
  description: string;
  budget: string;
  tier: string;
}

const ROLES: RoleRouting[] = [
  {
    id: "builder",
    role: "builder",
    description: "Primary implementation agent",
    budget: "20m / 30m",
    tier: "medium · sonnet-4-6 (high)",
  },
  {
    id: "reviewer",
    role: "reviewer",
    description: "Independent code review & diff impact analysis",
    budget: "15m / 20m",
    tier: "@reasoning · opus-4-6 (max)",
  },
  {
    id: "reflector",
    role: "reflector",
    description: "Post-lap lesson synthesis & codebase rules curation",
    budget: "15m / 20m",
    tier: "@reasoning · opus-4-6 (max)",
  },
  {
    id: "triage",
    role: "triage",
    description: "Repository-grounded backlog evaluation & admission",
    budget: "15m / 20m",
    tier: "medium · sonnet-4-6 (high)",
  },
  {
    id: "planner",
    role: "planner",
    description: "Spec decomposition, DAG coordination & integration",
    budget: "15m / 20m",
    tier: "large · opus-4-6 (xhigh)",
  },
];

export function ProjectModelsSection({
  currentProjectId,
}: {
  currentProjectId?: string | null;
} = {}) {
  const [defaultModel, setDefaultModel] = useState("claude-3-7-sonnet");
  const [concurrencyLimit, setConcurrencyLimit] = useState(2);

  useEffect(() => {
    const url = currentProjectId
      ? `/api/v1/settings/project?projectId=${encodeURIComponent(currentProjectId)}`
      : "/api/v1/settings/project";
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.models) return;
        if (data.models.defaultModel) setDefaultModel(data.models.defaultModel);
        if (data.models.concurrencyLimit) setConcurrencyLimit(data.models.concurrencyLimit);
      })
      .catch(() => {});
  }, [currentProjectId]);

  const saveModels = (updates: { defaultModel?: string; concurrencyLimit?: number }) => {
    const nextModel = updates.defaultModel ?? defaultModel;
    const nextConcurrency = updates.concurrencyLimit ?? concurrencyLimit;
    const url = currentProjectId
      ? `/api/v1/settings/project?projectId=${encodeURIComponent(currentProjectId)}`
      : "/api/v1/settings/project";

    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          defaultModel: nextModel,
          concurrencyLimit: nextConcurrency,
        },
      }),
    }).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Primary Model & Concurrency */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Boxes className="size-4 text-text-secondary" />
            <h3 className="text-base font-medium leading-[1.4] text-foreground">
              Primary model &amp; concurrency
            </h3>
          </div>
          <span className="text-xs text-text-secondary">Configured in .animus/config.yaml</span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* Default Model */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Default model
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Base foundation model used when not overridden by role routing.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-default-model"
                value={defaultModel}
                onChange={(e) => {
                  setDefaultModel(e.target.value);
                  saveModels({ defaultModel: e.target.value });
                }}
                className="h-[38px] w-[220px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                <option value="claude-3-7-sonnet">Claude 3.7 Sonnet</option>
                <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
                <option value="claude-opus-4-6">Claude Opus 4.6</option>
                <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
              />
            </div>
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
                className="h-[38px] w-[220px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
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

      {/* Model Tiers Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Boxes className="size-4 text-text-secondary" />
            <h3 className="text-base font-medium leading-[1.4] text-foreground">Model tiers</h3>
          </div>
          <span className="text-xs text-text-secondary">Provider, model, and effort</span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {TIERS.map((tier) => (
            <div key={tier.id} className="flex items-center justify-between gap-6 py-3.5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{tier.name}</span>
                  <Badge variant="outline" className="font-mono text-[10px] text-text-secondary">
                    {tier.key}
                  </Badge>
                </div>
                <span className="text-[13px] leading-[1.45] text-text-secondary">{tier.roles}</span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="rounded bg-white/5 px-2 py-1 font-mono text-foreground">
                  {tier.provider}
                </span>
                <span className="font-medium text-foreground">{tier.model}</span>
                <Badge variant="secondary" className="text-[11px]">
                  {tier.effort}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Role Routing Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-text-secondary" />
            <h3 className="text-base font-medium leading-[1.4] text-foreground">Role routing</h3>
          </div>
          <span className="text-xs text-text-secondary">Role mappings &amp; budgets</span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {ROLES.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-6 py-3.5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Badge
                    variant="default"
                    className="font-mono text-xs font-semibold text-foreground"
                  >
                    {r.role}
                  </Badge>
                </div>
                <span className="text-[13px] leading-[1.45] text-text-secondary">
                  {r.description}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <Badge variant="outline" className="font-mono text-[11px] text-text-secondary">
                  {r.budget}
                </Badge>
                <span className="rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[var(--card)] px-3 py-1.5 font-medium text-foreground">
                  {r.tier}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
