import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, FileCheck } from "lucide-react";

export function ProjectChecksSection({
  currentProjectId,
}: {
  currentProjectId?: string | null;
} = {}) {
  const [staticCmd, setStaticCmd] = useState("bun run check");
  const [unitCmd, setUnitCmd] = useState("bun test");
  const [countPattern, setCountPattern] = useState("Tests\\s+(\\d+)\\s+passed");
  const [protectedPaths, setProtectedPaths] = useState("MISSION.md,FACTORY.md,harness/**");

  useEffect(() => {
    const url = currentProjectId
      ? `/api/v1/settings/project?projectId=${encodeURIComponent(currentProjectId)}`
      : "/api/v1/settings/project";
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.checks) {
          if (data.checks.staticCmd) setStaticCmd(data.checks.staticCmd);
          if (data.checks.unitCmd) setUnitCmd(data.checks.unitCmd);
          if (data.checks.countPattern) setCountPattern(data.checks.countPattern);
          if (Array.isArray(data.checks.protectedPaths)) {
            setProtectedPaths(data.checks.protectedPaths.join(","));
          }
        }
      })
      .catch(() => {});
  }, [currentProjectId]);

  const saveChecks = (updates: {
    staticCmd?: string;
    unitCmd?: string;
    countPattern?: string;
    protectedPaths?: string;
  }) => {
    const nextStatic = updates.staticCmd ?? staticCmd;
    const nextUnit = updates.unitCmd ?? unitCmd;
    const nextPattern = updates.countPattern ?? countPattern;
    const nextPaths = (updates.protectedPaths ?? protectedPaths)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const url = currentProjectId
      ? `/api/v1/settings/project?projectId=${encodeURIComponent(currentProjectId)}`
      : "/api/v1/settings/project";

    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checks: {
          staticCmd: nextStatic,
          unitCmd: nextUnit,
          countPattern: nextPattern,
          protectedPaths: nextPaths,
        },
      }),
    }).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Verification Commands Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCheck className="size-4 text-text-secondary" />
            <h3 className="text-base font-medium leading-[1.4] text-foreground">
              Verification commands
            </h3>
          </div>
          <span className="rounded bg-white/5 px-2 py-0.5 font-mono text-xs text-text-secondary">
            Detected: typescript-bun
          </span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* Static Checks */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Static checks
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Run type checking, linting, and architecture gates before tests.
              </span>
            </div>
            <input
              type="text"
              value={staticCmd}
              onChange={(e) => setStaticCmd(e.target.value)}
              onBlur={() => saveChecks({ staticCmd })}
              className="h-[38px] w-64 rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-3 font-mono text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
            />
          </div>

          {/* Unit Tests */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">Unit tests</span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Run after static checks pass. Must exit successfully code 0.
              </span>
            </div>
            <input
              type="text"
              value={unitCmd}
              onChange={(e) => setUnitCmd(e.target.value)}
              onBlur={() => saveChecks({ unitCmd })}
              className="h-[38px] w-64 rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-3 font-mono text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
            />
          </div>

          {/* Test count pattern */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Test count pattern
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Confirm the test runner output contains at least one passing test.
              </span>
            </div>
            <input
              type="text"
              value={countPattern}
              onChange={(e) => setCountPattern(e.target.value)}
              onBlur={() => saveChecks({ countPattern })}
              className="h-[38px] w-64 rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-3 font-mono text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
            />
          </div>

          {/* Protected paths */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Protected paths
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Prevent autonomous agents from modifying critical governance files.
              </span>
            </div>
            <input
              type="text"
              value={protectedPaths}
              onChange={(e) => setProtectedPaths(e.target.value)}
              onBlur={() => saveChecks({ protectedPaths })}
              className="h-[38px] w-64 rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-3 font-mono text-xs text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
            />
          </div>
        </div>
      </section>

      {/* Harness Health Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">Harness health</h3>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* Agent instructions */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Agent instructions
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                118 of 150 lines · CLAUDE.md linked to AGENTS.md
              </span>
            </div>
            <Badge variant="success" className="font-medium">
              HEALTHY
            </Badge>
          </div>

          {/* Canonical Agent Skills */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Agent skills
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                19 of 19 canonical playbooks installed in .agents/skills/
              </span>
            </div>
            <Badge variant="success" className="font-medium">
              19 / 19 INSTALLED
            </Badge>
          </div>

          {/* Guard hooks */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">Guard hooks</span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Loop guard and holdout fence installed in .factory/hooks/
              </span>
            </div>
            <Badge variant="success" className="font-medium">
              ACTIVE
            </Badge>
          </div>

          {/* Acceptance holdouts */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Acceptance holdouts
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Isolated from builder and general agents in .factory/holdout/
              </span>
            </div>
            <Badge variant="outline" className="font-medium text-text-secondary">
              FENCED
            </Badge>
          </div>
        </div>
      </section>
    </div>
  );
}
