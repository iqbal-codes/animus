import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, Cpu } from "lucide-react";

interface ProviderItem {
  id: string;
  name: string;
  binary: string;
  path: string;
  version: string;
  efforts: string;
  capabilities: string;
  status: "INSTALLED" | "COMING SOON";
  enabled: boolean;
}

const INITIAL_PROVIDERS: ProviderItem[] = [
  {
    id: "pi",
    name: "Pi Coding Agent",
    binary: "pi",
    path: "/opt/homebrew/bin/pi",
    version: "v0.42.1",
    efforts: "minimal · low · medium · high · xhigh · max",
    capabilities: "Resume · Fork · Native Tools",
    status: "INSTALLED",
    enabled: true,
  },
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    path: "/usr/local/bin/claude",
    version: "v1.0.24 (built-in)",
    efforts: "low · medium · high · xhigh · max",
    capabilities: "Resume · Fork · Strict MCP",
    status: "INSTALLED",
    enabled: true,
  },
  {
    id: "omp",
    name: "Oh-My-Pi (OMP)",
    binary: "omp",
    path: "/Users/efishery/.bun/bin/omp",
    version: "v0.9.4",
    efforts: "minimal · low · medium · high · xhigh · max",
    capabilities: "Resume · Fork · Extension Hooks",
    status: "INSTALLED",
    enabled: false,
  },
  {
    id: "commandcode",
    name: "Command Code",
    binary: "commandcode",
    path: "/opt/homebrew/bin/commandcode",
    version: "CLI",
    efforts: "low · medium · high · xhigh · max",
    capabilities: "Resume · Fork",
    status: "INSTALLED",
    enabled: true,
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    binary: "codex",
    path: "codex exec --json",
    version: "built-in adapter",
    efforts: "minimal · low · medium · high · xhigh · max · ultra",
    capabilities: "Resume · Effort Clamping",
    status: "COMING SOON",
    enabled: false,
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",
    path: "opencode run --format json",
    version: "standalone",
    efforts: "low · medium · high",
    capabilities: "Resume · Auto Mode",
    status: "COMING SOON",
    enabled: false,
  },
];

export function PlatformProvidersSection() {
  const [primary, setPrimary] = useState("pi");
  const [offlineEval, setOfflineEval] = useState(false);
  const [providers, setProviders] = useState(INITIAL_PROVIDERS);

  useEffect(() => {
    fetch("/api/v1/settings/platform")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        if (data.system?.defaultProvider) {
          setPrimary(data.system.defaultProvider);
        }
        if (Array.isArray(data.providers) && data.providers.length > 0) {
          setProviders(data.providers);
        }
      })
      .catch(() => {});
  }, []);

  const savePlatformProviders = (nextPrimary: string, nextProviders: ProviderItem[]) => {
    fetch("/api/v1/settings/platform", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: { defaultProvider: nextPrimary },
        providers: nextProviders,
      }),
    }).catch(() => {});
  };

  const handlePrimaryChange = (val: string) => {
    setPrimary(val);
    savePlatformProviders(val, providers);
  };

  const toggleProvider = (id: string) => {
    const next = providers.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p));
    setProviders(next);
    savePlatformProviders(primary, next);
  };

  const installedCount = providers.filter((p) => p.status === "INSTALLED").length;
  const upcomingCount = providers.filter((p) => p.status === "COMING SOON").length;

  return (
    <div className="flex flex-col gap-8">
      {/* Platform Defaults Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Cpu className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">Platform defaults</h3>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* Primary Provider */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Primary provider
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Default provider used across all projects. Model and role routing remain in Project
                settings.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-primary-provider"
                value={primary}
                onChange={(e) => handlePrimaryChange(e.target.value)}
                className="h-[38px] w-[200px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                <option value="pi">Pi (pi)</option>
                <option value="claude">Claude Code (claude)</option>
                <option value="omp">Oh-My-Pi (omp)</option>
                <option value="commandcode">Command Code (commandcode)</option>
                <option value="codex">OpenAI Codex CLI (codex)</option>
                <option value="opencode">OpenCode (opencode)</option>
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
              />
            </div>
          </div>

          {/* Offline Evaluation */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Offline evaluation
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Skip live model calls during learning checks and local dry runs.
              </span>
            </div>
            <Switch checked={offlineEval} onCheckedChange={setOfflineEval} />
          </div>
        </div>
      </section>

      {/* Available Providers Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-medium leading-[1.4] text-foreground">
            Available providers
          </h3>
          <span className="text-xs text-text-secondary">
            {installedCount} installed · {upcomingCount} upcoming
          </span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {providers.map((provider) => {
            const isInstalled = provider.status === "INSTALLED";
            return (
              <div key={provider.id} className="flex items-center justify-between gap-6 py-4">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{provider.name}</span>
                    <Badge variant="outline" className="font-mono text-[10px] text-text-secondary">
                      {provider.binary}
                    </Badge>
                    <Badge
                      variant={isInstalled ? "success" : "default"}
                      className="text-[10px] tracking-wider uppercase"
                    >
                      {provider.status}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
                    <span>
                      {provider.path} · {provider.version}
                    </span>
                    <span>·</span>
                    <span className="text-text-muted">Efforts: {provider.efforts}</span>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <span className="hidden text-xs text-text-secondary sm:inline-block">
                    {provider.capabilities}
                  </span>
                  <Switch
                    checked={provider.enabled}
                    disabled={!isInstalled}
                    onCheckedChange={() => toggleProvider(provider.id)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
