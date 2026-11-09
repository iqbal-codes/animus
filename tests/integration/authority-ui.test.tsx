// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthorityPanel } from "../../apps/web/src/features/authority/authority-panel";

const backing = vi.hoisted(() => ({
  authorityStatus: vi.fn(),
  stageAuthorityCutover: vi.fn(),
  activateAuthorityCutover: vi.fn(),
  abortAuthorityCutover: vi.fn(),
}));

vi.mock("../../apps/web/src/lib/factory-client", () => ({
  client: {
    authorityStatus: (...args: unknown[]) => backing.authorityStatus(...args),
    stageAuthorityCutover: (...args: unknown[]) => backing.stageAuthorityCutover(...args),
    activateAuthorityCutover: (...args: unknown[]) => backing.activateAuthorityCutover(...args),
    abortAuthorityCutover: (...args: unknown[]) => backing.abortAuthorityCutover(...args),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const EMPTY_OPERATION = {
  id: "cutover_1",
  status: "staged" as const,
  actor: "operator",
  inventorySha256: "a".repeat(64),
  backupSnapshotId: "bkp_1",
  backupPath: "/tmp/backup",
  backupManifestSha256: "b".repeat(64),
  restoreOperationId: "restore_1",
  restoreTargetStateDir: "/tmp/restore/state",
  heldCount: 0,
  totalRows: 42,
  report: {},
  error: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  activatedAt: null,
};

function status(overrides: Record<string, unknown> = {}) {
  return {
    authority: "legacy",
    markerPhase: null,
    markerError: null,
    cutoverId: null,
    schemaVersion: 15,
    operation: null,
    tables: [
      {
        table: "projects",
        group: "projects",
        count: 1,
        digest: "c".repeat(64),
        identityDigest: "d".repeat(64),
      },
    ],
    artifacts: { root: "/tmp/artifacts", count: 2, totalBytes: 10, digest: "e".repeat(64) },
    legacyState: {
      digest: "9".repeat(64),
      roots: ["/tmp/home/projects/demo"],
      runs: 0,
      dossiers: 0,
      locks: 0,
      worktrees: 0,
      files: 0,
      malformed: 0,
    },
    held: [],
    mappingSummary: { total: 10, preserved: 8, preservedHistory: 2, adopted: 0, held: 0 },
    backup: {
      restorable: true,
      reasons: [],
      manifestHash: "b".repeat(64),
      databaseSha256: "f".repeat(64),
      artifactCount: 2,
    },
    isolatedRestore: null,
    installationHeld: false,
    authorityConsistent: true,
    blockingReasons: [],
    nextActions: ["stage the validated cutover"],
    ...overrides,
  };
}

describe("AuthorityPanel", () => {
  test("stages a legacy installation and refreshes to the fenced state", async () => {
    backing.authorityStatus.mockResolvedValueOnce(status()).mockResolvedValueOnce(
      status({
        authority: "migrating",
        markerPhase: "staged",
        cutoverId: "cutover_1",
        operation: EMPTY_OPERATION,
        isolatedRestore: {
          operationId: "restore_1",
          targetStateDir: "/tmp/restore/state",
          held: true,
          sourceRestoreId: "restore_1",
          schemaVersion: 15,
          stateDigest: "1".repeat(64),
          identityDigest: "2".repeat(64),
          artifactCount: 2,
        },
        nextActions: [],
      }),
    );
    backing.stageAuthorityCutover.mockResolvedValue({
      operation: EMPTY_OPERATION,
      inventory: { totalRows: 42, held: [] },
      restore: { targetStateDir: "/tmp/restore/state" },
      status: status({ authority: "migrating", operation: EMPTY_OPERATION }),
    });

    render(<AuthorityPanel />);
    expect(await screen.findByText("Legacy authority")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /stage validated cutover/i }));
    await waitFor(() => expect(backing.stageAuthorityCutover).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Cutover fenced")).toBeTruthy();
    expect(await screen.findByText(/isolated restore is held/i)).toBeTruthy();
  });

  test("shows held reasons and disables activation until every writer is quiesced", async () => {
    backing.authorityStatus.mockResolvedValue(
      status({
        authority: "migrating",
        markerPhase: "staged",
        cutoverId: "cutover_1",
        operation: { ...EMPTY_OPERATION, heldCount: 1 },
        held: [
          { entity: "project_runs", identity: "run_1", reason: "A live writer still owns it" },
        ],
        blockingReasons: ["live_writer:project_runs:run_1:A live writer still owns it"],
        nextActions: ["quiesce any live writers and re-run stage"],
        isolatedRestore: {
          operationId: "restore_1",
          targetStateDir: "/tmp/restore/state",
          held: true,
          sourceRestoreId: "restore_1",
          schemaVersion: 15,
          stateDigest: "1".repeat(64),
          identityDigest: "2".repeat(64),
          artifactCount: 2,
        },
      }),
    );

    render(<AuthorityPanel />);
    expect(await screen.findByText("Cutover fenced")).toBeTruthy();
    const activate = screen.getByRole("button", { name: /activate local authority/i });
    expect(activate).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /abort cutover/i })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByText(/live_writer:project_runs:run_1/)).toBeTruthy();
    expect(screen.getByText(/Held writers and ambiguous state/i)).toBeTruthy();
    expect(screen.getByText(/Quiesce the listed processes/i)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Execution authority" })).toBeTruthy();
  });

  test("surfaces filesystem legacy writers and an inconsistent local marker actionably", async () => {
    backing.authorityStatus.mockResolvedValue(
      status({
        authority: "local",
        markerPhase: "active",
        cutoverId: "cutover_1",
        operation: { ...EMPTY_OPERATION, status: "staged" },
        authorityConsistent: false,
        legacyState: {
          digest: "9".repeat(64),
          roots: ["/tmp/home/projects/demo"],
          runs: 1,
          dossiers: 0,
          locks: 1,
          worktrees: 0,
          files: 2,
          malformed: 0,
        },
        held: [
          {
            entity: "legacy_run",
            identity: "run:run_live_1",
            reason: "legacy run 'building' is live under pid 4242; quiesce it before cutover",
          },
        ],
        blockingReasons: ["authority_marker_without_activated_cutover"],
        nextActions: [],
      }),
    );

    render(<AuthorityPanel />);
    expect(await screen.findByText("Local authority active")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("not backed by an activated cutover");
    expect(screen.getByText(/legacy_run/)).toBeTruthy();
    expect(screen.getByText(/live under pid 4242/i)).toBeTruthy();
    expect(screen.getByText(/Legacy runs \/ locks \/ worktrees/)).toBeTruthy();
  });

  test("renders the activated local authority without staging actions", async () => {
    backing.authorityStatus.mockResolvedValue(
      status({
        authority: "local",
        markerPhase: "active",
        cutoverId: "cutover_1",
        operation: { ...EMPTY_OPERATION, status: "activated", activatedAt: 1_700_000_100_000 },
        isolatedRestore: {
          operationId: "restore_1",
          targetStateDir: "/tmp/restore/state",
          held: true,
          sourceRestoreId: "restore_1",
          schemaVersion: 15,
          stateDigest: "1".repeat(64),
          identityDigest: "2".repeat(64),
          artifactCount: 2,
        },
        nextActions: ["local execution authority is active"],
      }),
    );

    render(<AuthorityPanel />);
    expect(await screen.findByText("Local authority active")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stage validated cutover/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /activate local authority/i })).toBeNull();
    expect(screen.getAllByText("yes").length).toBeGreaterThan(0);
    const refresh = screen.getByRole("button", { name: /refresh execution authority/i });
    expect(refresh.className).toContain("h-11");
  });
});
