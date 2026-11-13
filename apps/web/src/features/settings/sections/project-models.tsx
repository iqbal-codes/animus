import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Boxes, ChevronDown, Cpu, Sparkles } from "lucide-react";

type TierKey = "small" | "medium" | "large";

interface TierBinding {
  provider: string;
  model: string;
  effort: string;
}

type TiersMap = Record<TierKey, TierBinding>;

interface HarnessCatalogState {
  models: string[];
  supportedEfforts: string[];
  defaultEffort: string;
  source?: string;
  catalogLive?: boolean;
  unavailableReason?: string;
}

interface RoleRouting {
  id: string;
  role: string;
  description: string;
  budget: string;
  bindingLabel: string;
}

const HARNESS_PROVIDERS = [
  { id: "pi", name: "Pi Coding Agent", badge: "CLI" },
  { id: "claude", name: "Claude Code", badge: "MCP" },
  { id: "omp", name: "Oh-My-Pi (OMP)", badge: "Hooks" },
  { id: "commandcode", name: "Command Code", badge: "CLI" },
  { id: "codex", name: "OpenAI Codex CLI", badge: "Adapter" },
  { id: "opencode", name: "OpenCode", badge: "Standalone" },
] as const;

const DEFAULT_EFFORTS_BY_PROVIDER: Record<string, string[]> = {
  pi: ["minimal", "low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  omp: ["minimal", "low", "medium", "high", "xhigh", "max"],
  commandcode: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  opencode: ["low", "medium", "high"],
};

const TIER_META: Record<TierKey, { name: string; roles: string; defaultEffort: string }> = {
  small: {
    name: "Small",
    roles: "Default for: qa, auditor",
    defaultEffort: "medium",
  },
  medium: {
    name: "Medium",
    roles: "Default for: builder, investigator, simplifier, triage",
    defaultEffort: "high",
  },
  large: {
    name: "Large",
    roles: "Default for: planner, reflector, reviewer, manager",
    defaultEffort: "high",
  },
};

function defaultTiers(provider = "pi", model = "default", effort = "high"): TiersMap {
  return {
    small: { provider, model, effort: "medium" },
    medium: { provider, model, effort },
    large: { provider, model, effort: effort === "max" || effort === "xhigh" ? effort : "high" },
  };
}

function clampEffortForProvider(effort: string | undefined, supported: string[]): string {
  if (effort && supported.includes(effort)) return effort;
  if (supported.includes("high")) return "high";
  return supported[0] ?? "medium";
}

export function ProjectModelsSection({
  currentProjectId,
}: {
  currentProjectId?: string | null;
} = {}) {
  const [assistant, setAssistant] = useState("pi");
  const [defaultModel, setDefaultModel] = useState("default");
  const [effort, setEffort] = useState("high");
  const [baseBranch, setBaseBranch] = useState("main");
  const [concurrencyLimit, setConcurrencyLimit] = useState(2);
  const [tiers, setTiers] = useState<TiersMap>(() => defaultTiers("pi", "default", "high"));
  const [catalogByProvider, setCatalogByProvider] = useState<Record<string, HarnessCatalogState>>(
    {},
  );
  const [loadingProviders, setLoadingProviders] = useState<Record<string, boolean>>({});
  const [customModelMode, setCustomModelMode] = useState<Record<string, boolean>>({});

  const ensureProviderCatalog = (providerId: string) => {
    const clean = providerId.toLowerCase();
    if (!clean || catalogByProvider[clean] || loadingProviders[clean]) return;
    setLoadingProviders((prev) => ({ ...prev, [clean]: true }));
    fetch(`/api/v1/settings/harness-models?provider=${encodeURIComponent(clean)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setCatalogByProvider((prev) => ({
          ...prev,
          [clean]: {
            models:
              Array.isArray(data.models) && data.models.length > 0 ? data.models : ["default"],
            supportedEfforts:
              Array.isArray(data.supportedEfforts) && data.supportedEfforts.length > 0
                ? data.supportedEfforts
                : (DEFAULT_EFFORTS_BY_PROVIDER[clean] ?? ["low", "medium", "high"]),
            defaultEffort: typeof data.defaultEffort === "string" ? data.defaultEffort : "high",
            ...(typeof data.source === "string" ? { source: data.source } : {}),
            ...(typeof data.catalogLive === "boolean" ? { catalogLive: data.catalogLive } : {}),
            ...(typeof data.unavailableReason === "string"
              ? { unavailableReason: data.unavailableReason }
              : {}),
          },
        }));
      })
      .catch(() => {})
      .finally(() => {
        setLoadingProviders((prev) => ({ ...prev, [clean]: false }));
      });
  };

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
        const branch = data.models.baseBranch || "main";

        const loadedTiers: TiersMap = {
          small: {
            provider: data.models.tiers?.small?.provider || prov,
            model: data.models.tiers?.small?.model || model,
            effort: data.models.tiers?.small?.effort || "medium",
          },
          medium: {
            provider: data.models.tiers?.medium?.provider || prov,
            model: data.models.tiers?.medium?.model || model,
            effort: data.models.tiers?.medium?.effort || eff,
          },
          large: {
            provider: data.models.tiers?.large?.provider || prov,
            model: data.models.tiers?.large?.model || model,
            effort:
              data.models.tiers?.large?.effort || (eff === "max" || eff === "xhigh" ? eff : "high"),
          },
        };

        setAssistant(prov);
        setDefaultModel(model);
        setEffort(eff);
        setBaseBranch(branch);
        setConcurrencyLimit(conc);
        setTiers(loadedTiers);

        for (const p of new Set([
          prov,
          loadedTiers.small.provider,
          loadedTiers.medium.provider,
          loadedTiers.large.provider,
        ])) {
          ensureProviderCatalog(p);
        }
      })
      .catch(() => {});
  }, [currentProjectId]);

  useEffect(() => {
    ensureProviderCatalog(assistant);
    ensureProviderCatalog(tiers.small.provider);
    ensureProviderCatalog(tiers.medium.provider);
    ensureProviderCatalog(tiers.large.provider);
  }, [assistant, tiers.small.provider, tiers.medium.provider, tiers.large.provider]);

  const saveModels = (updates: {
    assistant?: string;
    defaultModel?: string;
    effort?: string;
    baseBranch?: string;
    concurrencyLimit?: number;
    tiers?: TiersMap;
  }) => {
    const nextAssistant = updates.assistant ?? assistant;
    const nextModel = updates.defaultModel ?? defaultModel;
    const nextEffort = updates.effort ?? effort;
    const nextBranch = updates.baseBranch ?? baseBranch;
    const nextConcurrency = updates.concurrencyLimit ?? concurrencyLimit;
    const nextTiers = updates.tiers ?? tiers;

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
          baseBranch: nextBranch,
          concurrencyLimit: nextConcurrency,
          tiers: nextTiers,
          reasoningAlias: nextTiers.large,
        },
      }),
    }).catch(() => {});
  };

  const primaryCatalog = catalogByProvider[assistant];
  const primaryModels = primaryCatalog?.models ?? ["default"];
  const primaryEfforts = primaryCatalog?.supportedEfforts ??
    DEFAULT_EFFORTS_BY_PROVIDER[assistant] ?? ["low", "medium", "high"];
  const primaryLoading = Boolean(loadingProviders[assistant]);
  const primaryCustomActive =
    Boolean(customModelMode.primary) ||
    (!primaryLoading && Boolean(defaultModel) && !primaryModels.includes(defaultModel));

  const updateTier = (tierKey: TierKey, patch: Partial<TierBinding>) => {
    const prevTier = tiers[tierKey];
    const nextProvider = patch.provider ?? prevTier.provider;
    const nextSupportedEfforts = catalogByProvider[nextProvider]?.supportedEfforts ??
      DEFAULT_EFFORTS_BY_PROVIDER[nextProvider] ?? ["low", "medium", "high"];
    const nextEffort = clampEffortForProvider(
      patch.effort ?? prevTier.effort,
      nextSupportedEfforts,
    );
    const nextTier: TierBinding = {
      provider: nextProvider,
      model: patch.model ?? prevTier.model,
      effort: nextEffort,
    };
    const nextTiers: TiersMap = {
      ...tiers,
      [tierKey]: nextTier,
    };
    setTiers(nextTiers);
    if (tierKey === "medium") {
      setAssistant(nextTier.provider);
      setDefaultModel(nextTier.model);
      setEffort(nextTier.effort);
    }
    saveModels({
      ...(tierKey === "medium"
        ? { assistant: nextTier.provider, defaultModel: nextTier.model, effort: nextTier.effort }
        : {}),
      tiers: nextTiers,
    });
  };

  const applyPrimaryToAllTiers = (nextProvider: string, nextModel: string, nextEffort: string) => {
    const supported = catalogByProvider[nextProvider]?.supportedEfforts ??
      DEFAULT_EFFORTS_BY_PROVIDER[nextProvider] ?? ["low", "medium", "high"];
    const clampedMedium = clampEffortForProvider(nextEffort, supported);
    const clampedSmall = clampEffortForProvider("medium", supported);
    const clampedLarge = clampEffortForProvider(
      clampedMedium === "max" || clampedMedium === "xhigh" ? clampedMedium : "high",
      supported,
    );
    const nextTiers: TiersMap = {
      small: { provider: nextProvider, model: nextModel, effort: clampedSmall },
      medium: { provider: nextProvider, model: nextModel, effort: clampedMedium },
      large: { provider: nextProvider, model: nextModel, effort: clampedLarge },
    };
    setAssistant(nextProvider);
    setDefaultModel(nextModel);
    setEffort(clampedMedium);
    setTiers(nextTiers);
    saveModels({
      assistant: nextProvider,
      defaultModel: nextModel,
      effort: clampedMedium,
      tiers: nextTiers,
    });
  };

  const formatBinding = (b: TierBinding) => `${b.provider} · ${b.model} (${b.effort})`;

  const dynamicRoles: RoleRouting[] = [
    {
      id: "builder",
      role: "builder",
      description: "Primary implementation agent",
      budget: "20m / 30m",
      bindingLabel: `medium · ${formatBinding(tiers.medium)}`,
    },
    {
      id: "reviewer",
      role: "reviewer",
      description: "Independent code review & diff impact analysis",
      budget: "15m / 20m",
      bindingLabel: `@reasoning · ${formatBinding(tiers.large)}`,
    },
    {
      id: "reflector",
      role: "reflector",
      description: "Post-lap lesson synthesis & codebase rules curation",
      budget: "15m / 20m",
      bindingLabel: `@reasoning · ${formatBinding(tiers.large)}`,
    },
    {
      id: "triage",
      role: "triage",
      description: "Repository-grounded backlog evaluation & admission",
      budget: "15m / 20m",
      bindingLabel: `medium · ${formatBinding(tiers.medium)}`,
    },
    {
      id: "planner",
      role: "planner",
      description: "Spec decomposition, DAG coordination & integration",
      budget: "15m / 20m",
      bindingLabel: `large · ${formatBinding(tiers.large)}`,
    },
    {
      id: "qa",
      role: "qa",
      description: "Verification & regression checks",
      budget: "10m / 15m",
      bindingLabel: `small · ${formatBinding(tiers.small)}`,
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
              Primary harness, base branch &amp; concurrency
            </h3>
          </div>
          <span className="text-xs text-text-secondary">Configured in .animus/config.yaml</span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* Primary Harness / Provider */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Default execution harness
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Primary CLI harness for this repository. Changing this applies across all tiers; you
                can still customize each tier below.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-harness-provider"
                value={assistant}
                onChange={(e) => {
                  const val = e.target.value;
                  setCustomModelMode((prev) => ({ ...prev, primary: false }));
                  applyPrimaryToAllTiers(val, "default", effort);
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
                {primaryCatalog?.catalogLive && primaryCatalog.source
                  ? `Live catalog from ${primaryCatalog.source}.`
                  : primaryCatalog?.unavailableReason ||
                    `Select a preset from ${assistant} or enter a custom model ID.`}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <div className="relative">
                <select
                  id="settings-default-model"
                  value={primaryCustomActive ? "__custom__" : defaultModel}
                  disabled={primaryLoading}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "__custom__") {
                      setCustomModelMode((prev) => ({ ...prev, primary: true }));
                      return;
                    }
                    setCustomModelMode((prev) => ({ ...prev, primary: false }));
                    applyPrimaryToAllTiers(assistant, val, effort);
                  }}
                  className="h-[38px] w-[240px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)] disabled:opacity-50"
                >
                  {primaryLoading ? (
                    <option disabled>Loading models...</option>
                  ) : (
                    <>
                      {primaryModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__custom__">Enter custom model ID…</option>
                    </>
                  )}
                </select>
                <ChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
                />
              </div>
              {primaryCustomActive && (
                <input
                  aria-label="Custom default model ID"
                  type="text"
                  value={defaultModel}
                  onChange={(e) => setDefaultModel(e.target.value)}
                  onBlur={() => {
                    const clean = defaultModel.trim() || "default";
                    applyPrimaryToAllTiers(assistant, clean, effort);
                  }}
                  placeholder="provider/model-id"
                  className="h-[34px] w-[240px] rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-3 font-mono text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
                />
              )}
            </div>
          </div>

          {/* Reasoning Effort */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Default reasoning effort
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Thinking budget ladder supported natively by {assistant}.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-reasoning-effort"
                value={clampEffortForProvider(effort, primaryEfforts)}
                onChange={(e) => {
                  const val = e.target.value;
                  setEffort(val);
                  updateTier("medium", { effort: val });
                }}
                className="h-[38px] w-[240px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                {primaryEfforts.map((eff) => (
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
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="size-4 text-text-secondary" />
            <h3 className="text-base font-medium leading-[1.4] text-foreground">Model tiers</h3>
          </div>
          <span className="text-xs text-text-secondary">
            Mix harnesses, models, and effort per tier
          </span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {(["small", "medium", "large"] as const).map((tierKey) => {
            const binding = tiers[tierKey];
            const meta = TIER_META[tierKey];
            const tierCatalog = catalogByProvider[binding.provider];
            const tierModels = tierCatalog?.models ?? ["default"];
            const tierEfforts = tierCatalog?.supportedEfforts ??
              DEFAULT_EFFORTS_BY_PROVIDER[binding.provider] ?? ["low", "medium", "high"];
            const tierLoading = Boolean(loadingProviders[binding.provider]);
            const isCustom =
              Boolean(customModelMode[tierKey]) ||
              (!tierLoading && Boolean(binding.model) && !tierModels.includes(binding.model));

            return (
              <div key={tierKey} className="flex flex-col gap-3 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{meta.name}</span>
                    <Badge variant="outline" className="font-mono text-[10px] text-text-secondary">
                      {tierKey}
                    </Badge>
                  </div>
                  <span className="text-xs text-text-secondary">{meta.roles}</span>
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  {/* Tier Harness */}
                  <div className="relative">
                    <select
                      aria-label={`${meta.name} tier harness`}
                      value={binding.provider}
                      onChange={(e) => {
                        const nextProvider = e.target.value;
                        setCustomModelMode((prev) => ({ ...prev, [tierKey]: false }));
                        updateTier(tierKey, {
                          provider: nextProvider,
                          model: "default",
                        });
                      }}
                      className="h-[36px] w-full appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-8 pl-2.5 text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
                    >
                      {HARNESS_PROVIDERS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-text-secondary"
                    />
                  </div>

                  {/* Tier Model */}
                  <div className="flex flex-col gap-1.5">
                    <div className="relative">
                      <select
                        aria-label={`${meta.name} tier model`}
                        value={isCustom ? "__custom__" : binding.model}
                        disabled={tierLoading}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === "__custom__") {
                            setCustomModelMode((prev) => ({ ...prev, [tierKey]: true }));
                            return;
                          }
                          setCustomModelMode((prev) => ({ ...prev, [tierKey]: false }));
                          updateTier(tierKey, { model: val });
                        }}
                        className="h-[36px] w-full appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-8 pl-2.5 text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)] disabled:opacity-50"
                      >
                        {tierLoading ? (
                          <option disabled>Loading models...</option>
                        ) : (
                          <>
                            {tierModels.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                            <option value="__custom__">Enter custom model ID…</option>
                          </>
                        )}
                      </select>
                      <ChevronDown
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-text-secondary"
                      />
                    </div>
                    {isCustom && (
                      <input
                        aria-label={`${meta.name} custom model ID`}
                        type="text"
                        value={binding.model}
                        onChange={(e) => {
                          const val = e.target.value;
                          setTiers((prev) => ({
                            ...prev,
                            [tierKey]: { ...prev[tierKey], model: val },
                          }));
                        }}
                        onBlur={() => {
                          const clean = binding.model.trim() || "default";
                          updateTier(tierKey, { model: clean });
                        }}
                        placeholder="provider/model-id"
                        className="h-[32px] w-full rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-2.5 font-mono text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
                      />
                    )}
                  </div>

                  {/* Tier Effort */}
                  <div className="relative">
                    <select
                      aria-label={`${meta.name} tier effort`}
                      value={clampEffortForProvider(binding.effort, tierEfforts)}
                      onChange={(e) => updateTier(tierKey, { effort: e.target.value })}
                      className="h-[36px] w-full appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-8 pl-2.5 text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
                    >
                      {tierEfforts.map((eff) => (
                        <option key={eff} value={eff}>
                          Effort: {eff}
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
                  {r.bindingLabel}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
