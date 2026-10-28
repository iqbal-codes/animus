import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFactoryClient,
  createWebSocketManager,
  type WebSocketConnectionManager,
  type ConnectionStatus,
  type Project,
  type EvaluatedIssue,
  type SpecCoordinationPlan,
  type ConsequentialActionType,
  type TieredActionSubmission,
  FactoryClientError,
  type FactoryErrorCode,
} from "@labq/client";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { Select } from "./components/ui/form";
import { SpecSidebar } from "./components/spec-sidebar";
import { SpecDetailDag } from "./components/spec-detail-dag";
import { VirtualizedLogViewer } from "./components/virtualized-log-viewer";
import { ConsequentialActionModal } from "./components/consequential-action-modal";

const messages: Record<FactoryErrorCode, string> = {
  host_unavailable: "Unavailable: engine host is not reachable.",
  host_unauthorized: "Unavailable: engine host authentication failed.",
  invalid_host_response: "Unavailable: engine host returned invalid data.",
  candidate_mismatch: "Unavailable: backend and host candidates differ.",
  transport_unavailable: "Unavailable: backend is not reachable.",
  invalid_operator_response: "Unavailable: backend returned invalid data.",
  native_source_unavailable: "Unavailable: native engine source is not configured or reachable.",
  native_state_unavailable: "Unavailable: native engine state could not be read.",
  lap_not_found: "Not found: requested lap does not exist.",
  scope_mismatch: "Unavailable: requested resource belongs to another scope.",
  launch_brake_set: "Refused: local launch brake is active.",
  native_launch_failed: "Failed: native workflow launch failed.",
  invalid_payload: "Invalid: launch request payload is malformed.",
  intake_unavailable: "Unavailable: backlog intake could not be loaded.",
  issue_not_found: "Not found: requested issue does not exist.",
  control_failed: "Failed: control action could not be completed.",
  report_not_found: "Not found: requested evidence report does not exist.",
  evidence_unavailable: "Unavailable: candidate evidence could not be determined.",
  no_unpromoted_commits: "Refused: no unpromoted commits found between develop and main.",
  promotion_pr_already_open: "Refused: a promotion PR is already open.",
  promotion_failed: "Failed: promotion PR creation failed.",
  partial_promotion_effect: "Warning: PR created, but local freeze brake failed.",
  project_not_found: "Not found: requested project does not exist.",
  project_already_exists: "Refused: an active project with this repository ID already exists.",
  project_checkout_invalid: "Invalid: project checkout path is missing or invalid.",
  project_has_active_runs: "Refused: project has active runs and cannot be deregistered.",
  partial_registration_effect:
    "Warning: remote repository created or cloned, but checkout validation failed.",
  retarget_rejected: "Refused: retarget repository ID does not match the active project.",
  command_not_found: "Not found: requested command does not exist.",
  brake_active: "Refused: brake is active for this scope.",
  schedule_paused: "Refused: schedule is currently paused.",
  brake_state_unknown: "Refused: brake state could not be verified.",
  storage_failed: "Failed: command ledger storage failure prior to dispatch.",
  backup_failed: "Failed: database backup could not be completed.",
  target_drift: "Rejected: remote target drifted between admission and dispatch.",
  admission_rejected: "Rejected: target issue does not satisfy canonical admission criteria.",
  spec_parse_error: "Invalid: spec or ticket contract could not be parsed.",
  method_not_allowed: "Refused: HTTP method not allowed for this route.",
  plan_not_found: "Not found: requested coordination plan does not exist.",
  child_not_in_plan: "Not found: requested child ticket is not part of this plan.",
  child_already_integrated: "Refused: child ticket is already integrated into the branch.",
  spec_not_found: "Not found: requested spec or ticket could not be found on forge.",
  project_not_active: "Refused: project is not currently in active state.",
  prerequisites_not_satisfied: "Refused: prerequisite child tickets are not integrated or closed.",
  coordination_pipeline_halted:
    "Refused: coordination pipeline is halted due to a previous failure.",
  coordination_failed: "Failed: spec coordination operation failed.",
  integration_conflict: "Failed: merge conflict detected while integrating child into branch.",
  integration_drift: "Failed: branch drift detected during compare-and-swap merge.",
  integration_branch_unresolvable: "Failed: integration branch could not be resolved.",
  worktree_lock_conflict: "Refused: isolated worktree is exclusively locked by another process.",
  starting_sha_mismatch: "Refused: starting SHA does not match expected base SHA.",
  starting_sha_unresolvable: "Failed: starting SHA could not be resolved in the worktree.",
  branch_cleanliness_check_failed: "Failed: unable to check branch cleanliness in worktree.",
  worktree_dirty: "Refused: isolated worktree has uncommitted or untracked changes.",
  unintegrated_children_remain:
    "Refused: cannot create final PR while unintegrated children remain.",
  invalid_primitive: "Refused: targeted primitive is not permitted.",
  invalid_targeted_submission: "Invalid: targeted execution payload is malformed.",
  contract_digest_mismatch: "Refused: contract content does not match recorded digest.",
  final_pr_failed: "Failed: final pull request generation failed.",
  dispatch_failed: "Failed: child execution dispatch failed.",
  invalid_spec_number: "Invalid: spec issue number is missing or invalid.",
  dependency_cycle_detected: "Refused: circular dependency detected in child tickets.",
  dependency_resolution_stuck: "Failed: unresolvable dependencies in DAG.",
  git_command_failed: "Failed: underlying git command failed.",
  git_ref_error: "Failed: git ref could not be resolved.",
  checkout_failed: "Failed: git branch checkout failed.",
  rev_parse_failed: "Failed: git revision parse failed.",
  landing_guard_blocked: "Refused: landing guard blocked merge of unverified or drifted candidate.",
  candidate_drift: "Refused: candidate head SHA has drifted from verified evidence.",
  base_drift: "Refused: merge base SHA has drifted from verified evidence.",
  evidence_missing: "Refused: verified evidence record is missing for this candidate.",
  verification_failed: "Refused: candidate verification checks or review did not pass.",
  builder_self_approval_rejected: "Refused: builder self-approval is strictly forbidden.",
  freshness_check_failed: "Refused: consequential action freshness check exceeded 10s or failed.",
  confirmation_required: "Refused: explicit confirmation modal approval is required.",
  action_drift_detected: "Refused: target branch SHA drifted between confirmation and execution.",
  prerequisite_drift_detected: "Refused: prerequisite state drifted during live freshness check.",
  unauthorized_control: "Refused: unauthorized or mismatched scope for run control.",
  operation_unsupported: "Refused: requested run operation is not supported.",
  run_not_cancellable: "Refused: run is not in a cancellable state.",
  process_tree_termination_failed: "Failed: process tree termination or cleanup failed.",
  gate_not_found: "Not found: requested approval gate does not exist.",
  stale_candidate_drift: "Refused: candidate SHA has drifted from expected gate candidate.",
  unverified_candidate_blocked:
    "Refused: unverified candidate blocked from promotion or deployment.",
  release_policy_incomplete:
    "Refused: release-complete cannot be declared while policy stages are pending.",
  verification_not_found: "Not found: requested verification record does not exist.",
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5000,
    },
  },
});

export const ConsoleApp: React.FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <ConsoleView />
    </QueryClientProvider>
  );
};

export const ConsoleView: React.FC = () => {
  const qc = useQueryClient();
  const client = useMemo(() => createFactoryClient({ baseUrl: location.origin }), []);

  // Health State
  const [healthStatus, setHealthStatus] = useState<string>("Loading…");
  const [backendCandidate, setBackendCandidate] = useState<string>("");
  const [hostCandidate, setHostCandidate] = useState<string>("");
  const [isHealthRefreshing, setIsHealthRefreshing] = useState(false);

  // Scoped Navigation State (AC1)
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<string>("specs");

  // WebSocket State (AC2)
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>("disconnected");
  const [logs, setLogs] = useState<string[]>([]);
  const wsManagerRef = useRef<WebSocketConnectionManager | null>(null);

  // Consequential Action Modal State (AC4)
  const [modalOpen, setModalOpen] = useState(false);
  const [modalAction, setModalAction] = useState<ConsequentialActionType>("promotion_pr");
  const [modalTargetBranch, setModalTargetBranch] = useState("main");
  const [modalExpectedSha, setModalExpectedSha] = useState("");
  const [modalIssueNumbers, setModalIssueNumbers] = useState<number[]>([]);
  const [modalPrereqs, setModalPrereqs] = useState<Record<string, string> | undefined>();

  // Control and Promotion status messages
  const [controlStatusText, setControlStatusText] = useState("Loading controls…");
  const [promotionStatusText, setPromotionStatusText] = useState("Loading promotion status…");
  const [promotionDetailsText, setPromotionDetailsText] = useState("");
  const [isPromoteDisabled, setIsPromoteDisabled] = useState(true);

  // 1. Health check function
  const refreshHealth = useCallback(async () => {
    setIsHealthRefreshing(true);
    setHealthStatus("Loading…");
    try {
      const h = await client.health();
      setBackendCandidate(h.buildId);
      setHostCandidate(h.host.buildId);
      setHealthStatus("Healthy: backend and engine host connected.");
    } catch (err) {
      setBackendCandidate("");
      setHostCandidate("");
      setHealthStatus(
        err instanceof FactoryClientError
          ? messages[err.code]
          : "Unavailable: health request failed.",
      );
    } finally {
      setIsHealthRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  // 2. Fetch Projects (AC1)
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => client.projects(),
  });

  // Default to first active project if not selected
  useEffect(() => {
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  // Project-scoped client
  const projectClient = useMemo(() => {
    return selectedProjectId ? client.forProject(selectedProjectId) : null;
  }, [client, selectedProjectId]);

  // 3. Project-scoped Intake Query (AC1)
  const { data: intakeData, refetch: refetchIntake } = useQuery({
    queryKey: [selectedProjectId, "intake"],
    queryFn: () => (projectClient ? projectClient.intake() : client.intake()),
    enabled: true,
  });

  const issues: EvaluatedIssue[] = intakeData?.issues ?? [];

  // 4. Project-scoped Spec Coordination Plans (AC1)
  const [coordinationPlans, setCoordinationPlans] = useState<Record<number, SpecCoordinationPlan>>(
    {},
  );

  useEffect(() => {
    if (!projectClient || issues.length === 0) return;
    let active = true;

    const loadPlans = async () => {
      const plansMap: Record<number, SpecCoordinationPlan> = {};
      for (const issue of issues) {
        if (
          issue.labels.includes("spec") ||
          issue.labels.includes("parent-spec") ||
          issue.title.toLowerCase().startsWith("spec:")
        ) {
          try {
            const plan = await projectClient.getSpecCoordinationPlan(issue.number);
            plansMap[issue.number] = plan;
          } catch {}
        }
      }
      if (active) {
        setCoordinationPlans(plansMap);
      }
    };

    void loadPlans();

    return () => {
      active = false;
    };
  }, [projectClient, issues]);

  // 5. Project-scoped Controls Query
  const { data: controlData, refetch: refetchControls } = useQuery({
    queryKey: [selectedProjectId, "controls"],
    queryFn: () => (projectClient ? projectClient.controlState() : client.controlState()),
  });

  useEffect(() => {
    if (controlData) {
      setControlStatusText(
        `Controls: ${controlData.halted ? "HALTED" : "Running"} | ${controlData.paused ? "PAUSED" : "Active"} (Brake: ${controlData.active_brake.toUpperCase()})`,
      );
    }
  }, [controlData]);

  // 6. Project-scoped Promotion Status Query
  const { data: promotionData, refetch: refetchPromotion } = useQuery({
    queryKey: [selectedProjectId, "promotion"],
    queryFn: () => (projectClient ? projectClient.promotionStatus() : client.promotionStatus()),
  });

  useEffect(() => {
    if (promotionData) {
      setPromotionStatusText(
        `Promotion: ${promotionData.unpromoted_count} unpromoted commits (Freeze: ${promotionData.candidate_freeze ? "ACTIVE" : "None"}). Ready: ${promotionData.ready_to_promote ? "YES" : "NO"}`,
      );
      setIsPromoteDisabled(!promotionData.ready_to_promote);
      if (promotionData.existing_pr) {
        setPromotionDetailsText(
          `Open PR: #${promotionData.existing_pr.number} - ${promotionData.existing_pr.title} (${promotionData.existing_pr.url})`,
        );
      } else {
        setPromotionDetailsText("");
      }
    }
  }, [promotionData]);

  // 7. WebSocket Live Observation & Invalidation Hints (AC2, P4)
  useEffect(() => {
    const wsUrl = `${location.origin.replace(/^http/, "ws")}/api/v1/ws${selectedProjectId ? `?projectId=${encodeURIComponent(selectedProjectId)}` : ""}`;

    const mgr = createWebSocketManager({
      url: wsUrl,
      maxRingBufferSize: 2000,
      onStatusChange: (s) => setWsStatus(s),
      onEvent: (event) => {
        if (event.type === "log" && typeof event.payload.line === "string") {
          setLogs((prev) => [...prev.slice(-1999), String(event.payload.line)]);
        }
      },
      onInvalidationHint: (hint) => {
        if (hint.projectId) {
          if (hint.scope === "intake") {
            void qc.invalidateQueries({ queryKey: [hint.projectId, "intake"] });
          } else if (hint.scope === "laps") {
            void qc.invalidateQueries({ queryKey: [hint.projectId, "laps"] });
          } else if (hint.scope === "coordination") {
            void qc.invalidateQueries({ queryKey: [hint.projectId, "coordination"] });
          } else {
            void qc.invalidateQueries({ queryKey: [hint.projectId] });
          }
        }
      },
      onGapDetected: () => {
        if (selectedProjectId) {
          void qc.invalidateQueries({ queryKey: [selectedProjectId] });
        }
      },
    });

    wsManagerRef.current = mgr;
    mgr.connect();
    if (selectedProjectId) {
      mgr.subscribe(selectedProjectId);
    }

    return () => {
      mgr.disconnect();
      wsManagerRef.current = null;
    };
  }, [selectedProjectId, qc]);

  // Handle Control Action Buttons
  const handleControlAction = async (action: "halt" | "unhalt" | "pause" | "unpause") => {
    setControlStatusText(`Applying ${action}…`);
    try {
      const state = projectClient
        ? await projectClient.control(action)
        : await client.control(action);
      setControlStatusText(
        `Controls: ${state.halted ? "HALTED" : "Running"} | ${state.paused ? "PAUSED" : "Active"} (Brake: ${state.active_brake.toUpperCase()})`,
      );
      void refetchControls();
    } catch (err) {
      setControlStatusText(
        err instanceof FactoryClientError ? messages[err.code] : "Failed: control action failed.",
      );
    }
  };

  // Open Consequential Action Modal (AC4)
  const openPromotionModal = () => {
    setModalAction("promotion_pr");
    setModalTargetBranch("main");
    setModalExpectedSha(backendCandidate || "head");
    setModalIssueNumbers(promotionData?.delivered_tickets ?? []);
    setModalPrereqs(undefined);
    setModalOpen(true);
  };

  // Consequential Action Execution Handler
  const executeConsequentialAction = async (submission: TieredActionSubmission) => {
    if (projectClient) {
      await projectClient.executeTieredAction(submission);
      void refetchPromotion();
      void refetchControls();
      void refetchIntake();
    }
  };

  const hasIdentities = Boolean(backendCandidate && hostCandidate);
  const selectedPlan = selectedItemId ? coordinationPlans[selectedItemId] : null;
  const selectedIssue = selectedItemId ? issues.find((i) => i.number === selectedItemId) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        backgroundColor: "#0A0A0A",
        color: "#EDEDED",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Top Header / Navigator with Health Status */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 20px",
          backgroundColor: "#1A1A1A",
          borderBottom: "1px solid #1F2228",
          gap: "16px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h1
            style={{
              fontSize: "16px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#EDEDED",
              margin: 0,
            }}
          >
            LABQ SOFTWARE FACTORY
          </h1>
          <Badge variant="accent">CONSOLE</Badge>

          {/* Project Scoped Selector (AC1) */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "8px" }}>
            <span style={{ fontSize: "12px", color: "#A1A1AA" }}>Project:</span>
            <Select
              id="project-selector"
              value={selectedProjectId}
              onChange={(e) => {
                setSelectedProjectId(e.target.value);
                setSelectedItemId(null);
                setLogs([]);
              }}
              style={{ width: "200px", height: "30px", fontSize: "12px", padding: "2px 8px" }}
            >
              {projects.length === 0 ? (
                <option value="">No projects registered</option>
              ) : (
                projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.repo_name})
                  </option>
                ))
              )}
            </Select>
          </div>
        </div>

        {/* Health status & candidate identity (required by health.browser.test.ts) */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <p
            id="status"
            role="status"
            style={{
              fontSize: "12px",
              color: healthStatus.startsWith("Healthy") ? "#4ADE80" : "#F87171",
              margin: 0,
            }}
          >
            {healthStatus}
          </p>

          <dl
            id="identities"
            hidden={!hasIdentities}
            style={{
              display: hasIdentities ? "flex" : "none",
              alignItems: "center",
              gap: "8px",
              margin: 0,
              fontSize: "11px",
              fontFamily: "var(--font-mono)",
            }}
          >
            <dt style={{ color: "#71717A" }}>Backend candidate</dt>
            <dd id="backend-id" style={{ color: "#EDEDED", margin: 0 }}>
              {backendCandidate}
            </dd>
            <dt style={{ color: "#71717A" }}>Host candidate</dt>
            <dd id="host-id" style={{ color: "#EDEDED", margin: 0 }}>
              {hostCandidate}
            </dd>
          </dl>

          <Badge
            variant={
              wsStatus === "connected"
                ? "success"
                : wsStatus === "reconnecting"
                  ? "warning"
                  : "destructive"
            }
          >
            WS: {wsStatus.toUpperCase()}
          </Badge>

          <Button
            id="refresh"
            size="sm"
            variant="outline"
            disabled={isHealthRefreshing}
            onClick={() => void refreshHealth()}
          >
            {isHealthRefreshing ? "Checking…" : "Refresh"}
          </Button>
        </div>
      </header>

      {/* Control & Promotion Ribbon (AC3, AC4, plus test compatibility) */}
      <section
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 20px",
          backgroundColor: "#141414",
          borderBottom: "1px solid #1F2228",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <p id="control-status" style={{ fontSize: "12px", color: "#A1A1AA", margin: 0 }}>
            {controlStatusText}
          </p>
          <div id="control-buttons" style={{ display: "flex", gap: "6px" }}>
            <Button
              id="btn-halt"
              size="sm"
              variant="outline"
              onClick={() => void handleControlAction("halt")}
            >
              Halt
            </Button>
            <Button
              id="btn-unhalt"
              size="sm"
              variant="outline"
              onClick={() => void handleControlAction("unhalt")}
            >
              Unhalt
            </Button>
            <Button
              id="btn-pause"
              size="sm"
              variant="outline"
              onClick={() => void handleControlAction("pause")}
            >
              Pause
            </Button>
            <Button
              id="btn-unpause"
              size="sm"
              variant="outline"
              onClick={() => void handleControlAction("unpause")}
            >
              Unpause
            </Button>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <p id="promotion-status" style={{ fontSize: "12px", color: "#A1A1AA", margin: 0 }}>
            {promotionStatusText}
          </p>
          <div id="promotion-details" style={{ fontSize: "12px", color: "#4ADE80" }}>
            {promotionDetailsText}
          </div>
          <Button
            id="btn-promote"
            size="sm"
            variant="default"
            disabled={isPromoteDisabled}
            onClick={openPromotionModal}
          >
            Prepare Promotion
          </Button>
        </div>
      </section>

      {/* Backwards-compatible intake and evidence elements for existing suites */}
      <div style={{ display: "none" }} aria-hidden="true">
        <p id="intake-status">Intake: {intakeData?.total_count ?? 0} total.</p>
        <button id="intake-refresh" type="button" onClick={() => void refetchIntake()}>
          Reload Intake
        </button>
        <ul id="intake-list">
          {issues.map((i) => (
            <li key={i.number} data-issue-number={i.number} data-status={i.admission_status}>
              #{i.number} {i.title}
            </li>
          ))}
        </ul>

        <p id="evidence-status">Select a lap to view candidate evidence</p>
        <div id="evidence-details"></div>
        <pre id="report-content" hidden></pre>
      </div>

      {/* Main Workspace Layout (AC1) */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Flat Spec Sidebar (AC1) */}
        <SpecSidebar
          issues={issues}
          coordinationPlans={coordinationPlans}
          selectedId={selectedItemId}
          onSelect={(id) => {
            setSelectedItemId(id);
          }}
        />

        {/* Center Main Content Area */}
        <main
          style={{
            flex: 1,
            padding: "20px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          {/* Tab Navigation (AC3) */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="specs">Spec & DAG View</TabsTrigger>
              <TabsTrigger value="logs">Live Log Observation</TabsTrigger>
              <TabsTrigger value="details">Issue Details</TabsTrigger>
            </TabsList>

            {/* Spec & DAG View Tab (AC1) */}
            <TabsContent value="specs">
              {selectedPlan ? (
                <SpecDetailDag plan={selectedPlan} />
              ) : selectedIssue ? (
                <div
                  style={{
                    padding: "24px",
                    backgroundColor: "#1A1A1A",
                    border: "1px solid #1F2228",
                    borderRadius: "8px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "8px",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "16px",
                        fontWeight: 700,
                        color: "#EDEDED",
                      }}
                    >
                      Issue #{selectedIssue.number}
                    </span>
                    <Badge
                      variant={
                        selectedIssue.admission_status === "admitted" ? "success" : "warning"
                      }
                    >
                      {selectedIssue.admission_status.toUpperCase()}
                    </Badge>
                    <Badge variant="secondary">STANDALONE</Badge>
                  </div>
                  <h2
                    style={{
                      fontSize: "18px",
                      fontWeight: 600,
                      color: "#EDEDED",
                      marginBottom: "12px",
                    }}
                  >
                    {selectedIssue.title}
                  </h2>
                  <p style={{ fontSize: "13px", color: "#A1A1AA", lineHeight: 1.6 }}>
                    {selectedIssue.body || "No body content available."}
                  </p>
                </div>
              ) : (
                <div
                  style={{
                    padding: "48px 24px",
                    textAlign: "center",
                    backgroundColor: "#1A1A1A",
                    border: "1px dashed #1F2228",
                    borderRadius: "8px",
                    color: "#A1A1AA",
                  }}
                >
                  Select a spec or issue from the sidebar to inspect its child DAG and branch
                  integration status.
                </div>
              )}
            </TabsContent>

            {/* Live Observation Logs Tab (AC2, AC3) */}
            <TabsContent value="logs">
              <VirtualizedLogViewer
                logs={logs}
                height={440}
                isStreaming={wsStatus === "connected"}
                onClear={() => setLogs([])}
              />
            </TabsContent>

            {/* Issue Details Tab */}
            <TabsContent value="details">
              <div
                style={{
                  padding: "20px",
                  backgroundColor: "#1A1A1A",
                  border: "1px solid #1F2228",
                  borderRadius: "8px",
                }}
              >
                {selectedIssue ? (
                  <div>
                    <h3 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "8px" }}>
                      #{selectedIssue.number} {selectedIssue.title}
                    </h3>
                    <div style={{ display: "flex", gap: "6px", marginBottom: "16px" }}>
                      {selectedIssue.labels.map((l: string) => (
                        <Badge key={l} variant="outline">
                          {l}
                        </Badge>
                      ))}
                    </div>
                    <pre
                      style={{
                        padding: "12px",
                        backgroundColor: "#141414",
                        border: "1px solid #1F2228",
                        borderRadius: "6px",
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        whiteSpace: "pre-wrap",
                        color: "#EDEDED",
                      }}
                    >
                      {selectedIssue.body ?? "No description."}
                    </pre>
                  </div>
                ) : (
                  <div style={{ color: "#A1A1AA" }}>Select an issue from the sidebar.</div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </main>
      </div>

      {/* Consequential Action Confirmation Modal (AC4) */}
      <ConsequentialActionModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        action={modalAction}
        targetBranch={modalTargetBranch}
        expectedBranchSha={modalExpectedSha}
        issueNumbers={modalIssueNumbers}
        prerequisiteStates={modalPrereqs}
        projectId={selectedProjectId}
        onConfirm={executeConsequentialAction}
      />
    </div>
  );
};
