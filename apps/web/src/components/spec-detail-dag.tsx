import React from "react";
import { Badge } from "./ui/badge";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "./ui/table";
import type { SpecCoordinationPlan, CoordinatedChildTicket } from "@labq/contracts/operator";

export interface SpecDetailDagProps {
  plan: SpecCoordinationPlan;
  className?: string;
  style?: React.CSSProperties;
}

export const SpecDetailDag: React.FC<SpecDetailDagProps> = ({ plan, className = "", style }) => {
  const statusVariantMap: Record<
    string,
    "success" | "warning" | "destructive" | "accent" | "default" | "secondary"
  > = {
    integrated_to_branch: "success",
    running: "accent",
    dispatched: "warning",
    failed: "destructive",
    pending: "secondary",
  };

  const integratedCount = plan.children.filter((c) => c.status === "integrated_to_branch").length;
  const totalCount = plan.children.length;

  return (
    <div
      id="spec-detail-dag"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        backgroundColor: "#1A1A1A",
        border: "1px solid #1F2228",
        borderRadius: "8px",
        padding: "18px",
        ...style,
      }}
      className={`ui-spec-detail-dag ${className}`}
    >
      {/* Header Info */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          borderBottom: "1px solid #1F2228",
          paddingBottom: "14px",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "16px",
                fontWeight: 700,
                color: "#FF6308",
              }}
            >
              Spec #{plan.specIssueNumber}
            </span>
            <Badge
              variant={
                plan.status === "completed"
                  ? "success"
                  : plan.status === "halted"
                    ? "destructive"
                    : "accent"
              }
            >
              {plan.status.toUpperCase()}
            </Badge>
            <Badge variant="outline">
              PROGRESS: {integratedCount}/{totalCount}
            </Badge>
          </div>
          <div style={{ fontSize: "12px", color: "#A1A1AA", fontFamily: "var(--font-mono)" }}>
            Project: <strong style={{ color: "#EDEDED" }}>{plan.projectId}</strong>
          </div>
        </div>

        {plan.finalPullRequest && (
          <div
            style={{
              padding: "6px 12px",
              backgroundColor: "rgba(22, 163, 74, 0.15)",
              border: "1px solid rgba(22, 163, 74, 0.4)",
              borderRadius: "6px",
              fontSize: "12px",
            }}
          >
            <span style={{ color: "#4ADE80", fontWeight: 600 }}>
              Final PR #{plan.finalPullRequest.number}:
            </span>{" "}
            <a
              href={plan.finalPullRequest.url}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#EDEDED", textDecoration: "underline" }}
            >
              {plan.finalPullRequest.title}
            </a>
          </div>
        )}
      </div>

      {/* Branch & Integration Metadata */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "10px",
          padding: "12px",
          backgroundColor: "#141414",
          border: "1px solid #1F2228",
          borderRadius: "6px",
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
        }}
      >
        <div>
          <span style={{ color: "#71717A" }}>Integration Branch:</span>
          <div style={{ color: "#EDEDED", fontWeight: 600 }}>{plan.integrationBranch}</div>
        </div>
        <div>
          <span style={{ color: "#71717A" }}>Base Branch:</span>
          <div style={{ color: "#EDEDED" }}>{plan.baseBranch}</div>
        </div>
        <div>
          <span style={{ color: "#71717A" }}>Base SHA:</span>
          <div style={{ color: "#EDEDED" }}>{plan.baseSha.slice(0, 10)}</div>
        </div>
        <div>
          <span style={{ color: "#71717A" }}>Current Integration SHA:</span>
          <div style={{ color: "#4ADE80" }}>
            {plan.currentIntegrationSha ? plan.currentIntegrationSha.slice(0, 10) : "Not started"}
          </div>
        </div>
      </div>

      {plan.haltReason && (
        <div
          style={{
            padding: "10px 14px",
            backgroundColor: "rgba(220, 38, 38, 0.15)",
            border: "1px solid rgba(220, 38, 38, 0.4)",
            borderRadius: "6px",
            color: "#F87171",
            fontSize: "12px",
          }}
        >
          <strong>PIPELINE HALTED:</strong> {plan.haltReason}
        </div>
      )}

      {/* DAG Visual Nodes */}
      <div>
        <h3 style={{ fontSize: "13px", fontWeight: 600, color: "#EDEDED", marginBottom: "8px" }}>
          Child DAG Execution Graph
        </h3>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "12px",
            padding: "14px",
            backgroundColor: "#141414",
            border: "1px solid #1F2228",
            borderRadius: "6px",
          }}
        >
          {plan.children.map((child: CoordinatedChildTicket) => {
            const deps = plan.dag[String(child.number)] ?? [];
            return (
              <div
                key={child.number}
                data-testid={`dag-node-${child.number}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  padding: "10px 14px",
                  backgroundColor: "#1A1A1A",
                  border:
                    child.status === "integrated_to_branch"
                      ? "1px solid #16A34A"
                      : child.status === "running"
                        ? "1px solid #FF6308"
                        : "1px solid #1F2228",
                  borderRadius: "6px",
                  minWidth: "160px",
                }}
              >
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "13px",
                      fontWeight: 700,
                      color: "#EDEDED",
                    }}
                  >
                    #{child.number}
                  </span>
                  <Badge variant={statusVariantMap[child.status] ?? "default"}>
                    {child.status}
                  </Badge>
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "#A1A1AA",
                    maxWidth: "200px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {child.title}
                </div>
                {deps.length > 0 && (
                  <div
                    style={{ fontSize: "11px", color: "#71717A", fontFamily: "var(--font-mono)" }}
                  >
                    Depends on: {deps.map((d) => `#${d}`).join(", ")}
                  </div>
                )}
                {child.commitSha && (
                  <div
                    style={{ fontSize: "11px", color: "#4ADE80", fontFamily: "var(--font-mono)" }}
                  >
                    SHA: {child.commitSha.slice(0, 8)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Child Tickets Table */}
      <div>
        <h3 style={{ fontSize: "13px", fontWeight: 600, color: "#EDEDED", marginBottom: "8px" }}>
          Branch Integration Status
        </h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Child Issue</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Dependencies</TableHead>
              <TableHead>Integrated Commit</TableHead>
              <TableHead>Worktree</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.children.map((child: CoordinatedChildTicket) => {
              const deps = plan.dag[String(child.number)] ?? [];
              return (
                <TableRow key={child.number}>
                  <TableCell style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                    #{child.number}
                  </TableCell>
                  <TableCell>{child.title}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariantMap[child.status] ?? "default"}>
                      {child.status}
                    </Badge>
                  </TableCell>
                  <TableCell style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>
                    {deps.length > 0 ? deps.map((d) => `#${d}`).join(", ") : "None"}
                  </TableCell>
                  <TableCell
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      color: child.commitSha ? "#4ADE80" : "#71717A",
                    }}
                  >
                    {child.commitSha ? child.commitSha.slice(0, 8) : "-"}
                  </TableCell>
                  <TableCell
                    style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "#71717A" }}
                  >
                    {child.worktreePath ?? "-"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};
