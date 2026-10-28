import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import type { ConsequentialActionType, TieredActionSubmission } from "@labq/contracts/operator";

export interface ConsequentialActionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: ConsequentialActionType;
  targetBranch: string;
  expectedBranchSha: string;
  issueNumbers: number[];
  prerequisiteStates?: Record<string, string>;
  projectId: string;
  onFreshnessCheck?: () => Promise<{ liveBranchSha: string; prerequisitesOk: boolean }>;
  onConfirm: (submission: TieredActionSubmission) => Promise<void>;
}

export const ConsequentialActionModal: React.FC<ConsequentialActionModalProps> = ({
  open,
  onOpenChange,
  action,
  targetBranch,
  expectedBranchSha,
  issueNumbers,
  prerequisiteStates,
  onFreshnessCheck,
  onConfirm,
}) => {
  const [isChecking, setIsChecking] = useState(true);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [driftDetected, setDriftDetected] = useState(false);
  const [driftReason, setDriftReason] = useState<string>("");
  const [freshnessFailed, setFreshnessFailed] = useState(false);
  const [liveSha, setLiveSha] = useState<string>("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setIsChecking(true);
      setElapsedMs(0);
      setDriftDetected(false);
      setDriftReason("");
      setFreshnessFailed(false);
      setLiveSha("");
      setIsExecuting(false);
      setActionError(null);
      return;
    }

    let active = true;
    const startTime = Date.now();

    const timer = setInterval(() => {
      if (active) {
        setElapsedMs(Date.now() - startTime);
      }
    }, 100);

    const runCheck = async () => {
      try {
        let liveBranchSha = expectedBranchSha;
        let prereqsOk = true;

        if (onFreshnessCheck) {
          const res = await onFreshnessCheck();
          liveBranchSha = res.liveBranchSha;
          prereqsOk = res.prerequisitesOk;
        }

        const duration = Date.now() - startTime;
        if (!active) return;
        setElapsedMs(duration);
        setLiveSha(liveBranchSha);

        // AC12 / AC4: Live freshness rule: ≤ 10s
        if (duration > 10_000) {
          setFreshnessFailed(true);
          setDriftReason(
            `Freshness check exceeded 10-second threshold (${duration}ms). Fails closed.`,
          );
          setIsChecking(false);
          return;
        }

        // Branch SHA Drift Check
        if (liveBranchSha !== expectedBranchSha) {
          setDriftDetected(true);
          setDriftReason(
            `Target branch ${targetBranch} SHA drifted: expected ${expectedBranchSha.slice(0, 8)}, but found live ${liveBranchSha.slice(0, 8)}. Confirmation blocked.`,
          );
          setIsChecking(false);
          return;
        }

        // Prerequisite drift check
        if (!prereqsOk) {
          setDriftDetected(true);
          setDriftReason("One or more prerequisite states drifted. Confirmation blocked.");
          setIsChecking(false);
          return;
        }

        // Freshness verified
        setIsChecking(false);
      } catch (err: any) {
        if (!active) return;
        setFreshnessFailed(true);
        setDriftReason(`Freshness check query failed: ${err?.message || String(err)}`);
        setIsChecking(false);
      } finally {
        clearInterval(timer);
      }
    };

    void runCheck();

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, action, targetBranch, expectedBranchSha, onFreshnessCheck]);

  const handleConfirm = async () => {
    if (isChecking || driftDetected || freshnessFailed || isExecuting) return;
    setIsExecuting(true);
    setActionError(null);
    try {
      const submission: TieredActionSubmission = {
        action,
        targetBranch,
        expectedBranchSha,
        issueNumbers,
        prerequisiteStates,
        confirmed: true,
      };
      await onConfirm(submission);
      onOpenChange(false);
    } catch (err: any) {
      setActionError(err?.message || "Action execution failed.");
    } finally {
      setIsExecuting(false);
    }
  };

  const actionLabels: Record<ConsequentialActionType, string> = {
    launch: "Launch Workflow",
    cancel: "Cancel Active Run",
    gate_approval: "Approve Gate",
    promotion_pr: "Prepare Promotion PR",
    merge: "Merge / Land Final PR",
    deploy: "Deploy Release",
  };

  const canConfirm = !isChecking && !driftDetected && !freshnessFailed && !isExecuting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent id="consequential-action-dialog">
        <DialogHeader>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <Badge variant="accent">CONSEQUENTIAL ACTION</Badge>
            <Badge variant="outline">{action.toUpperCase()}</Badge>
          </div>
          <DialogTitle>{actionLabels[action]}</DialogTitle>
          <DialogDescription>
            This is a consequential irreversible action. Confirming this operation executes changes
            against forge and engine authority.
          </DialogDescription>
        </DialogHeader>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            margin: "16px 0",
            padding: "12px",
            backgroundColor: "#141414",
            border: "1px solid #1F2228",
            borderRadius: "6px",
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "#A1A1AA" }}>Target Branch:</span>
            <span style={{ color: "#EDEDED", fontWeight: 600 }}>{targetBranch}</span>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "#A1A1AA" }}>Candidate SHA:</span>
            <span style={{ color: "#EDEDED" }}>{expectedBranchSha.slice(0, 10)}</span>
          </div>

          {liveSha && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#A1A1AA" }}>Live Verified SHA:</span>
              <span style={{ color: liveSha === expectedBranchSha ? "#4ADE80" : "#F87171" }}>
                {liveSha.slice(0, 10)}
              </span>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "#A1A1AA" }}>Issue Numbers:</span>
            <span style={{ color: "#EDEDED" }}>
              {issueNumbers.length > 0 ? issueNumbers.map((n) => `#${n}`).join(", ") : "None"}
            </span>
          </div>

          <div
            style={{
              marginTop: "8px",
              paddingTop: "8px",
              borderTop: "1px solid #1F2228",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ color: "#A1A1AA" }}>Live Freshness (≤10s):</span>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {isChecking ? (
                <Badge variant="warning">CHECKING ({(elapsedMs / 1000).toFixed(1)}s)</Badge>
              ) : driftDetected || freshnessFailed ? (
                <Badge variant="destructive">FAILED ({(elapsedMs / 1000).toFixed(1)}s)</Badge>
              ) : (
                <Badge variant="success">VERIFIED ({(elapsedMs / 1000).toFixed(1)}s)</Badge>
              )}
            </div>
          </div>
        </div>

        {(driftDetected || freshnessFailed) && (
          <div
            id="drift-warning-box"
            style={{
              padding: "10px 14px",
              backgroundColor: "rgba(220, 38, 38, 0.15)",
              border: "1px solid rgba(220, 38, 38, 0.4)",
              borderRadius: "6px",
              color: "#F87171",
              fontSize: "12px",
              lineHeight: 1.5,
              marginBottom: "12px",
            }}
          >
            <strong>DRIFT DETECTED:</strong> {driftReason}
          </div>
        )}

        {actionError && (
          <div
            style={{
              padding: "10px 14px",
              backgroundColor: "rgba(220, 38, 38, 0.15)",
              border: "1px solid rgba(220, 38, 38, 0.4)",
              borderRadius: "6px",
              color: "#F87171",
              fontSize: "12px",
              marginBottom: "12px",
            }}
          >
            {actionError}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isExecuting}>
            Cancel
          </Button>
          <Button
            id="btn-confirm-consequential"
            variant={driftDetected || freshnessFailed ? "secondary" : "default"}
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            {isExecuting
              ? "Executing..."
              : isChecking
                ? "Checking Freshness..."
                : "Confirm & Execute"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
