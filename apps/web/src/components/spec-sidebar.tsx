import React, { useState, useMemo } from "react";
import { Badge } from "./ui/badge";
import { Input } from "./ui/form";
import type { EvaluatedIssue, SpecCoordinationPlan } from "@labq/contracts/operator";

export interface SpecSidebarItem {
  id: number;
  title: string;
  isSpec: boolean;
  isPlanningRecord: boolean;
  isStandalone: boolean;
  progressText?: string; // e.g. "2/10"
  integratedToBranch?: string | null;
  statusText: string;
}

export interface SpecSidebarProps {
  issues: EvaluatedIssue[];
  coordinationPlans: Record<number, SpecCoordinationPlan>;
  selectedId: number | null;
  onSelect: (id: number, isSpec: boolean) => void;
  className?: string;
  style?: React.CSSProperties;
}

export const SpecSidebar: React.FC<SpecSidebarProps> = ({
  issues,
  coordinationPlans,
  selectedId,
  onSelect,
  className = "",
  style,
}) => {
  const [filter, setFilter] = useState("");

  const items = useMemo<SpecSidebarItem[]>(() => {
    return issues.map((issue) => {
      const plan = coordinationPlans[issue.number];
      const isSpec = Boolean(
        plan ||
        issue.labels.includes("spec") ||
        issue.labels.includes("parent-spec") ||
        issue.title.toLowerCase().startsWith("spec:"),
      );
      const isPlanningRecord =
        issue.labels.includes("needs-info") ||
        issue.labels.includes("ready-for-human") ||
        issue.labels.includes("needs-triage") ||
        (isSpec && (!plan || plan.status === "planning"));

      let progressText: string | undefined;
      if (plan && plan.children && plan.children.length > 0) {
        const integrated = plan.children.filter((c) => c.status === "integrated_to_branch").length;
        progressText = `${integrated}/${plan.children.length}`;
      } else if (isSpec) {
        progressText = "0/0";
      }

      const isStandalone = !isSpec;

      return {
        id: issue.number,
        title: issue.title,
        isSpec,
        isPlanningRecord,
        isStandalone,
        progressText,
        integratedToBranch: issue.integrated_to_branch,
        statusText: plan?.status ? plan.status.toUpperCase() : issue.admission_status.toUpperCase(),
      };
    });
  }, [issues, coordinationPlans]);

  const filteredItems = useMemo(() => {
    if (!filter.trim()) return items;
    const lower = filter.toLowerCase();
    return items.filter(
      (item) =>
        String(item.id).includes(lower) ||
        item.title.toLowerCase().includes(lower) ||
        (item.progressText && item.progressText.includes(lower)),
    );
  }, [items, filter]);

  return (
    <aside
      id="spec-sidebar"
      style={{
        display: "flex",
        flexDirection: "column",
        width: "320px",
        backgroundColor: "#141414",
        borderRight: "1px solid #1F2228",
        height: "100%",
        minHeight: "450px",
        overflow: "hidden",
        ...style,
      }}
      className={`ui-spec-sidebar ${className}`}
    >
      <div
        style={{
          padding: "12px",
          borderBottom: "1px solid #1F2228",
          backgroundColor: "#1A1A1A",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "8px",
          }}
        >
          <span
            style={{ fontSize: "12px", fontWeight: 600, color: "#EDEDED", letterSpacing: "0.02em" }}
          >
            SPECS & BACKLOG
          </span>
          <Badge variant="secondary">{filteredItems.length} items</Badge>
        </div>
        <Input
          id="spec-sidebar-search"
          placeholder="Filter specs & issues..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ height: "30px", fontSize: "12px" }}
        />
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "6px",
          display: "flex",
          flexDirection: "column",
          gap: "4px",
        }}
      >
        {filteredItems.length === 0 ? (
          <div
            style={{
              padding: "24px 12px",
              textAlign: "center",
              color: "#A1A1AA",
              fontSize: "12px",
            }}
          >
            No specs or issues match.
          </div>
        ) : (
          filteredItems.map((item) => {
            const isSelected = selectedId === item.id;
            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                data-testid={`sidebar-item-${item.id}`}
                onClick={() => onSelect(item.id, item.isSpec)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    onSelect(item.id, item.isSpec);
                  }
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  padding: "10px",
                  borderRadius: "6px",
                  cursor: "pointer",
                  backgroundColor: isSelected ? "#1F2228" : "#1A1A1A",
                  border: isSelected ? "1px solid #FF6308" : "1px solid #1F2228",
                  transition: "all 0.12s ease",
                  outline: "none",
                }}
              >
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      fontWeight: 700,
                      color: isSelected ? "#FF6308" : "#EDEDED",
                    }}
                  >
                    #{item.id}
                  </span>
                  <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                    {item.progressText && (
                      <Badge variant="accent" data-testid={`progress-${item.id}`}>
                        {item.progressText}
                      </Badge>
                    )}
                    {item.isPlanningRecord && <Badge variant="warning">PLANNING</Badge>}
                    {item.isStandalone && <Badge variant="secondary">STANDALONE</Badge>}
                  </div>
                </div>

                <div
                  style={{
                    fontSize: "12px",
                    color: isSelected ? "#EDEDED" : "#D4D4D8",
                    lineHeight: 1.4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {item.title}
                </div>

                {item.integratedToBranch && (
                  <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <span
                      style={{ fontSize: "11px", color: "#4ADE80", fontFamily: "var(--font-mono)" }}
                    >
                      ✓ {item.integratedToBranch}
                    </span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
