import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, Cpu, Plus, Trash2 } from "lucide-react";

export type BuiltinTierKey = "small" | "medium" | "large";

export interface TierBinding {
  provider: string;
  model: string;
  effort: string;
}

export type TiersMap = Record<string, TierBinding>;

export interface HarnessCatalogState {
  models: string[];
  supportedEfforts: string[];
  defaultEffort: string;
  source?: string;
  catalogLive?: boolean;
  unavailableReason?: string;
}

export const HARNESS_PROVIDERS = [
  { id: "pi", name: "Pi Coding Agent", badge: "CLI" },
  { id: "claude", name: "Claude Code", badge: "MCP" },
  { id: "omp", name: "Oh-My-Pi (OMP)", badge: "Hooks" },
  { id: "commandcode", name: "Command Code", badge: "CLI" },
  { id: "codex", name: "OpenAI Codex CLI", badge: "Adapter" },
  { id: "opencode", name: "OpenCode", badge: "Standalone" },
] as const;

export const DEFAULT_EFFORTS_BY_PROVIDER: Record<string, string[]> = {
  pi: ["minimal", "low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  omp: ["minimal", "low", "medium", "high", "xhigh", "max"],
  commandcode: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  opencode: ["low", "medium", "high"],
};

export const BUILTIN_TIER_KEYS: readonly BuiltinTierKey[] = ["small", "medium", "large"];

export const TIER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function defaultTiers(provider = "pi", model = "default"): TiersMap {
  return {
    small: { provider, model, effort: "medium" },
    medium: { provider, model, effort: "high" },
    large: { provider, model, effort: "high" },
  };
}

export function clampEffortForProvider(effort: string | undefined, supported: string[]): string {
  if (effort && supported.includes(effort)) return effort;
  if (supported.includes("high")) return "high";
  return supported[0] ?? "medium";
}

export function formatTierLabel(tierKey: string): string {
  return tierKey.charAt(0).toUpperCase() + tierKey.slice(1);
}

export function orderedTierKeys(tiers: TiersMap): string[] {
  const keys = Object.keys(tiers);
  const builtins = BUILTIN_TIER_KEYS.filter((k) => keys.includes(k));
  const custom = keys.filter((k) => !(BUILTIN_TIER_KEYS as readonly string[]).includes(k)).sort();
  return [...builtins, ...custom];
}

export function useHarnessCatalogs(providersToLoad: string[]) {
  const [catalogByProvider, setCatalogByProvider] = useState<Record<string, HarnessCatalogState>>(
    {},
  );
  const [loadingProviders, setLoadingProviders] = useState<Record<string, boolean>>({});

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

  useEffect(() => {
    for (const p of new Set(providersToLoad)) {
      ensureProviderCatalog(p);
    }
  }, [providersToLoad.join(",")]);

  return { catalogByProvider, loadingProviders, ensureProviderCatalog };
}

export function ModelTiersCard({
  title = "Model tiers",
  subtitle = "Mix harnesses, models, and effort per tier",
  tiers,
  rolesByTier,
  inUseCustomTiers,
  defaultNewProvider = "pi",
  catalogByProvider,
  loadingProviders,
  onChangeTiers,
  onDraftTierModel,
}: {
  title?: string;
  subtitle?: string;
  tiers: TiersMap;
  rolesByTier?: Record<string, string[]>;
  inUseCustomTiers?: Set<string>;
  defaultNewProvider?: string;
  catalogByProvider: Record<string, HarnessCatalogState>;
  loadingProviders: Record<string, boolean>;
  onChangeTiers: (nextTiers: TiersMap) => void;
  onDraftTierModel?: (tierKey: string, model: string) => void;
}) {
  const [customModelMode, setCustomModelMode] = useState<Record<string, boolean>>({});
  const [addingTier, setAddingTier] = useState(false);
  const [newTierName, setNewTierName] = useState("");
  const [newTierError, setNewTierError] = useState<string | null>(null);

  const tierKeys = orderedTierKeys(tiers);

  const handleUpdateTier = (tierKey: string, patch: Partial<TierBinding>) => {
    const prevTier = tiers[tierKey];
    if (!prevTier) return;
    const nextProvider = patch.provider ?? prevTier.provider;
    const nextSupportedEfforts = catalogByProvider[nextProvider]?.supportedEfforts ??
      DEFAULT_EFFORTS_BY_PROVIDER[nextProvider] ?? ["low", "medium", "high"];
    const nextEffort = clampEffortForProvider(
      patch.effort ?? prevTier.effort,
      nextSupportedEfforts,
    );
    const nextTiers: TiersMap = {
      ...tiers,
      [tierKey]: {
        provider: nextProvider,
        model: patch.model ?? prevTier.model,
        effort: nextEffort,
      },
    };
    onChangeTiers(nextTiers);
  };

  const handleAddTier = () => {
    const normalized = newTierName.trim().toLowerCase();
    if (!TIER_NAME_PATTERN.test(normalized)) {
      setNewTierError("Use lowercase letters, numbers, '-' or '_' (e.g. xhigh, max).");
      return;
    }
    if (tiers[normalized]) {
      setNewTierError(`Tier "${normalized}" already exists.`);
      return;
    }
    const base = tiers.large ??
      tiers.medium ?? {
        provider: defaultNewProvider,
        model: "default",
        effort: "high",
      };
    const nextTiers: TiersMap = {
      ...tiers,
      [normalized]: {
        provider: base.provider,
        model: base.model,
        effort: base.effort,
      },
    };
    onChangeTiers(nextTiers);
    setNewTierName("");
    setNewTierError(null);
    setAddingTier(false);
  };

  const handleRemoveTier = (tierKey: string) => {
    if ((BUILTIN_TIER_KEYS as readonly string[]).includes(tierKey)) return;
    const nextTiers = { ...tiers };
    delete nextTiers[tierKey];
    onChangeTiers(nextTiers);
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Cpu className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">{title}</h3>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-secondary">{subtitle}</span>
          {!addingTier && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setAddingTier(true);
                setNewTierError(null);
              }}
              className="h-7 gap-1 px-2.5 text-xs"
            >
              <Plus className="size-3.5" />
              Add tier
            </Button>
          )}
        </div>
      </div>

      {addingTier && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="New tier name"
              type="text"
              value={newTierName}
              onChange={(e) => {
                setNewTierName(e.target.value);
                if (newTierError) setNewTierError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddTier();
                }
              }}
              placeholder="e.g. xhigh or max"
              className="h-[34px] min-w-[200px] flex-1 rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-3 font-mono text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
            />
            <Button
              type="button"
              size="sm"
              onClick={handleAddTier}
              className="h-[34px] px-3 text-xs"
            >
              Create tier
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setAddingTier(false);
                setNewTierName("");
                setNewTierError(null);
              }}
              className="h-[34px] px-2.5 text-xs"
            >
              Cancel
            </Button>
          </div>
          {newTierError && <span className="text-xs text-red-400">{newTierError}</span>}
        </div>
      )}

      <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
        {tierKeys.map((tierKey) => {
          const binding = tiers[tierKey]!;
          const isBuiltin = (BUILTIN_TIER_KEYS as readonly string[]).includes(tierKey);
          const displayLabel = formatTierLabel(tierKey);
          const assignedRoles = rolesByTier?.[tierKey] ?? [];
          const tierCatalog = catalogByProvider[binding.provider];
          const tierModels = tierCatalog?.models ?? ["default"];
          const tierEfforts = tierCatalog?.supportedEfforts ??
            DEFAULT_EFFORTS_BY_PROVIDER[binding.provider] ?? ["low", "medium", "high"];
          const tierLoading = Boolean(loadingProviders[binding.provider]);
          const isCustomModel =
            Boolean(customModelMode[tierKey]) ||
            (!tierLoading && Boolean(binding.model) && !tierModels.includes(binding.model));
          const isTierInUse = Boolean(inUseCustomTiers?.has(tierKey));

          return (
            <div key={tierKey} className="flex flex-col gap-3 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{displayLabel}</span>
                  <Badge variant="outline" className="font-mono text-[10px] text-text-secondary">
                    {tierKey}
                  </Badge>
                  {!isBuiltin && (
                    <Badge variant="secondary" className="text-[10px] text-text-secondary">
                      custom
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {rolesByTier !== undefined && (
                    <span className="text-xs text-text-secondary">
                      {assignedRoles.length > 0
                        ? `Used by: ${assignedRoles.join(", ")}`
                        : "Unused by pipeline roles"}
                    </span>
                  )}
                  {!isBuiltin && (
                    <button
                      type="button"
                      aria-label={`Remove ${tierKey} tier`}
                      disabled={isTierInUse}
                      title={
                        isTierInUse
                          ? "Reassign roles using this tier before removing it"
                          : `Remove ${tierKey} tier`
                      }
                      onClick={() => handleRemoveTier(tierKey)}
                      className="inline-flex size-6 items-center justify-center rounded text-text-secondary transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                {/* Tier Harness */}
                <div className="relative">
                  <select
                    aria-label={`${displayLabel} tier harness`}
                    value={binding.provider}
                    onChange={(e) => {
                      const nextProvider = e.target.value;
                      setCustomModelMode((prev) => ({ ...prev, [tierKey]: false }));
                      handleUpdateTier(tierKey, {
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
                      aria-label={`${displayLabel} tier model`}
                      value={isCustomModel ? "__custom__" : binding.model}
                      disabled={tierLoading}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "__custom__") {
                          setCustomModelMode((prev) => ({ ...prev, [tierKey]: true }));
                          return;
                        }
                        setCustomModelMode((prev) => ({ ...prev, [tierKey]: false }));
                        handleUpdateTier(tierKey, { model: val });
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
                  {isCustomModel && (
                    <input
                      aria-label={`${displayLabel} custom model ID`}
                      type="text"
                      value={binding.model}
                      onChange={(e) => {
                        const val = e.target.value;
                        onDraftTierModel?.(tierKey, val);
                      }}
                      onBlur={() => {
                        const clean = binding.model.trim() || "default";
                        handleUpdateTier(tierKey, { model: clean });
                      }}
                      placeholder="provider/model-id"
                      className="h-[32px] w-full rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-2.5 font-mono text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
                    />
                  )}
                </div>

                {/* Tier Effort */}
                <div className="relative">
                  <select
                    aria-label={`${displayLabel} tier effort`}
                    value={clampEffortForProvider(binding.effort, tierEfforts)}
                    onChange={(e) => handleUpdateTier(tierKey, { effort: e.target.value })}
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
  );
}
