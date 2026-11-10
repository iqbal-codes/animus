import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Boxes, ChevronDown, Cpu, Sparkles } from "lucide-react";

interface RoleRouting {
  id: string;
  role: string;
  description: string;
  budget: string;
  tier: string;
}

const HARNESS_PROVIDERS = [
  { id: "pi", name: "Pi Coding Agent", badge: "Default" },
  { id: "claude", name: "Claude Code", badge: "MCP" },
  { id: "omp", name: "Oh-My-Pi (OMP)", badge: "Hooks" },
  { id: "codex", name: "OpenAI Codex CLI", badge: "Adapter" },
  { id: "opencode", name: "OpenCode", badge: "Autonomous" },
  { id: "commandcode", name: "Command Code", badge: "CLI" },
];

export function ProjectModelsSection({
  currentProjectId,
}: {
  currentProjectId?: string | null;
} = {}) {
  const [assistant, setAssistant] = useState("pi");
  const [defaultModel, setDefaultModel] = useState("default");
  const [effort, setEffort] = useState("high");
  const [concurrencyLimit, setConcurrencyLimit] = useState(2);
  const [availableModels, setAvailableModels] = useState<string[]>(["default"]);
  const [availableEfforts, setAvailableEfforts] = useState<string[]>([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const [loadingModels, setLoadingModels] = useState(false);

  // Load project settings on mount or when currentProjectId changes
  useEffect(() => {
    const url = currentProjectId
      ? `/api/v1/settings/project?projectId=${encodeURIComponent(currentProjectId)}`
      : "/api/v1/settings/project";

    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.models) return;
        const prov = data.models.assistant || "pi";
        const model = data.models.defaultModel || "default";
        const eff = data.models.effort || "high";
        const conc = data.models.concurrencyLimit ?? 2;

        setAssistant(prov);
        setDefaultModel(model);
        setEffort(eff);
        setConcurrencyLimit(conc);
      })
      .catch(() => {});
  }, [currentProjectId]);

  // Load models & efforts dynamically when harness/assistant changes
  useEffect(() => {
    setLoadingModels(true);
    fetch(`/api/v1/settings/harness-models?provider=${encodeURIComponent(assistant)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        if (Array.isArray(data.models)) {
          setAvailableModels(data.models);
        }
        if (Array.isArray(data.supportedEfforts)) {
          setAvailableEfforts(data.supportedEfforts);
        }
      })
      .catch(() => {})
      .finally(() => {
        setLoadingModels(false);
      });
  }, [assistant]);

  const saveModels = (updates: {
    assistant?: string;
    defaultModel?: string;
    effort?: string;
    concurrencyLimit?: number;
  }) => {
    const nextAssistant = updates.assistant ?? assistant;
    const nextModel = updates.defaultModel ?? defaultModel;
    const nextEffort = updates.effort ?? effort;
    const nextConcurrency = updates.concurrencyLimit ?? concurrencyLimit;

    const url = currentProjectId
      ? `/api/v1/settings/project?projectId=${encodeURIComponent(currentProjectId)}`
      : "/api/v1/settings/project";

    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          assistant: nextAssistant,
          defaultModel: nextModel,
          effort: nextEffort,
          concurrencyLimit: nextConcurrency,
        },
      }),
    }).catch(() => {});
  };

  const dynamicTiers = [
    {
      id: "small",
      name: "Small",
      key: "small",
      roles: "Default for: qa, auditor",
      provider: assistant,
      model: defaultModel,
      effort: availableEfforts.includes("low") ? "low" : availableEfforts[0] || "low",
    },
    {
      id: "medium",
      name: "Medium",
      key: "medium",
      roles: "Default for: builder, investigator, simplifier, triage",
      provider: assistant,
      model: defaultModel,
      effort: effort,
    },
    {
      id: "large",
      name: "Large",
      key: "large",
      roles: "Default for: planner, reflector, reviewer",
      provider: assistant,
      model: defaultModel,
      effort: availableEfforts.includes("max")
        ? "max"
        : availableEfforts.includes("xhigh")
          ? "xhigh"
          : availableEfforts[availableEfforts.length - 1] || "high",
    },
  ];

  const dynamicRoles: RoleRouting[] = [
    {
      id: "builder",
      role: "builder",
      description: "Primary implementation agent",
      budget: "20m / 30m",
      tier: `medium · ${defaultModel} (${effort})`,
    },
    {
      id: "reviewer",
      role: "reviewer",
      description: "Independent code review & diff impact analysis",
      budget: "15m / 20m",
      tier: `@reasoning · ${defaultModel} (max)`,
    },
    {
      id: "reflector",
      role: "reflector",
      description: "Post-lap lesson synthesis & codebase rules curation",
      budget: "15m / 20m",
      tier: `@reasoning · ${defaultModel} (max)`,
    },
    {
      id: "triage",
      role: "triage",
      description: "Repository-grounded backlog evaluation & admission",
      budget: "15m / 20m",
      tier: `medium · ${defaultModel} (${effort})`,
    },
    {
      id: "planner",
      role: "planner",
      description: "Spec decomposition, DAG coordination & integration",
      budget: "15m / 20m",
      tier: `large · ${defaultModel} (xhigh)`,
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      {/* Primary Model, Harness & Concurrency */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Boxes className="size-4 text-text-secondary" />
            <h3 className="text-base font-medium leading-[1.4] text-foreground">
              Primary model, harness &amp; concurrency
            </h3>
          </div>
          <span className="text-xs text-text-secondary">Configured in .animus/config.yaml</span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* Harness / Provider */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Execution harness
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Autonomous agent harness CLI used to drive loops and subagents.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-harness-provider"
                value={assistant}
                onChange={(e) => {
                  const val = e.target.value;
                  setAssistant(val);
                  setDefaultModel("default");
                  saveModels({ assistant: val, defaultModel: "default" });
                }}
                className="h-[38px] w-[240px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                {HARNESS_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.badge})
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
              />
            </div>
          </div>

          {/* Default Model */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Default model
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Dynamically retrieved from {assistant} harness catalog.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-default-model"
                value={defaultModel}
                disabled={loadingModels}
                onChange={(e) => {
                  const val = e.target.value;
                  setDefaultModel(val);
                  saveModels({ defaultModel: val });
                }}
                className="h-[38px] w-[240px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)] disabled:opacity-50"
              >
                {loadingModels ? (
                  <option disabled>Loading models...</option>
                ) : (
                  availableModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))
                )}
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
              />
            </div>
          </div>

          {/* Reasoning Effort */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Reasoning effort
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Thinking budget ladder supported natively by {assistant}.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-reasoning-effort"
                value={effort}
                onChange={(e) => {
                  const val = e.target.value;
                  setEffort(val);
                  saveModels({ effort: val });
                }}
                className="h-[38px] w-[240px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                {availableEfforts.map((eff) => (
                  <option key={eff} value={eff}>
                    {eff.charAt(0).toUpperCase() + eff.slice(1)}
                  </option>
                ))}
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

      {/* Model Tiers Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="size-4 text-text-secondary" />
            <h3 className="text-base font-medium leading-[1.4] text-foreground">Model tiers</h3>
          </div>
          <span className="text-xs text-text-secondary">Provider, model, and effort</span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {dynamicTiers.map((tier) => (
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
          {dynamicRoles.map((r) => (
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
