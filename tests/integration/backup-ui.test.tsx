// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackupPanel } from "../../apps/web/src/features/backup/backup-panel";

const backing = vi.hoisted(() => ({
  backupStatus: vi.fn(),
  restoreStatus: vi.fn(),
  createWorkspaceBackup: vi.fn(),
  restoreWorkspace: vi.fn(),
  reconcileRestore: vi.fn(),
}));

vi.mock("../../apps/web/src/lib/factory-client", () => ({
  client: {
    backupStatus: backlog("backupStatus"),
    restoreStatus: backlog("restoreStatus"),
    createWorkspaceBackup: backlog("createWorkspaceBackup"),
    restoreWorkspace: backlog("restoreWorkspace"),
    reconcileRestore: backlog("reconcileRestore"),
  },
}));

function backlog(name: keyof typeof backing) {
  return (...args: unknown[]) => backing[name](...args);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function status(restorable = true) {
  return {
    lastBackup: {
      id: "bkp_1",
      destinationPath: "/secure/backup",
      manifestVersion: 1,
      manifestHash: "a".repeat(64),
      databaseSha256: "b".repeat(64),
      databaseSizeBytes: 4096,
      artifactCount: 2,
      schemaVersion: 11,
      status: "complete",
      createdBy: "operator",
      error: null,
      verifiedAt: 1_700_000_000_000,
      createdAt: 1_700_000_000_000,
      finishedAt: 1_700_000_000_000,
    },
    restorable,
    reasons: restorable ? [] : ["artifact_digest_mismatch:evidence/log.txt"],
    artifactCount: 2,
    credentials: {
      included: false,
      reconfigurationRequired: ["FACTORY_HOST_TOKEN"],
      note: "Reconfigure every external credential in the restored home before enabling dispatch or publication.",
    },
    sameDiskWarning:
      "A backup written to the same disk or filesystem as the live Animus home is lost with that disk.",
  };
}

function installation(held: boolean) {
  return {
    installation: {
      held,
      status: held ? "held" : "reconciled",
      reason: held ? "held pending reconciliation" : null,
      sourceRestoreId: held ? "restore_1" : null,
      restoredAt: held ? 1_700_000_000_000 : null,
      reconciledAt: held ? null : 1_700_000_100_000,
      reconciliation: held
        ? null
        : {
            releasedAt: 1_700_000_100_000,
            actor: "operator",
            reason: "verified",
            runs: [],
            intents: [],
          },
    },
    lastRestore: null,
    heldRunCount: held ? 1 : 0,
    pendingPublicationIntentCount: held ? 2 : 0,
    unresolved: {
      runs: held
        ? [
            {
              runId: "run_1",
              projectId: "proj_1",
              issueNumber: 701,
              state: "interrupted",
              branch: "factory/spec-1/ticket-701",
              worktreePath: "/restored/home/projects/p/worktrees/ticket-701",
              worktreePresent: false,
              ownerPidCleared: true,
              leaseCleared: true,
            },
          ]
        : [],
      intents: held
        ? [
            {
              intentId: "int_1",
              projectId: "proj_1",
              kind: "publish_event",
              operationKey: "event:evt_1",
              state: "queued",
              attempts: 0,
              remoteObservation: "unverified",
              remoteDetail: "Remote readback runs when the installation hold is released",
            },
          ]
        : [],
    },
  };
}

function factory() {
  return {
    backupStatus: () => backing.backupStatus(),
    restoreStatus: () => backing.restoreStatus(),
    createWorkspaceBackup: (submission: unknown) => backing.createWorkspaceBackup(submission),
    restoreWorkspace: (submission: unknown) => backing.restoreWorkspace(submission),
    reconcileRestore: (submission: unknown) => backing.reconcileRestore(submission),
  } as never;
}

describe("workspace backup and restore operator panel", () => {
  test("renders a verified backup, credential and same-disk limits, and mobile 44px targets", async () => {
    backing.backupStatus.mockResolvedValue(status(true));
    backing.restoreStatus.mockResolvedValue(installation(false));
    render(<BackupPanel factory={factory()} />);

    const toggle = screen.getByRole("button", { name: /open backup controls/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.className).toContain("min-h-11");
    fireEvent.click(toggle);

    await waitFor(() => expect(backing.backupStatus).toHaveBeenCalledTimes(1));
    expect(screen.getByText("last backup verified")).toBeTruthy();
    expect(screen.getByText(/Credentials are never included/i)).toBeTruthy();
    expect(screen.getByText(/same disk/i)).toBeTruthy();

    const destination = screen.getByLabelText(/destination bundle directory/i);
    expect(destination.className).toContain("min-h-11");
    const source = screen.getByLabelText(/backup bundle source/i);
    const target = screen.getByLabelText(/target state directory/i);
    expect(source.className).toContain("min-h-11");
    expect(target.className).toContain("min-h-11");

    const createButton = screen.getByRole("button", { name: /^create backup$/i });
    expect(createButton.className).toContain("min-h-11");
    const restoreButton = screen.getByRole("button", { name: /^restore workspace$/i });
    expect(restoreButton.className).toContain("min-h-11");

    // Responsive single-column at 390px, two columns at desktop widths.
    const grid = destination.closest(".grid");
    expect(grid?.className).toContain("grid-cols-1");
    expect(grid?.className).toContain("md:grid-cols-2");
  });

  test("shows an honest non-restorable reason and still allows a fresh backup attempt", async () => {
    backing.backupStatus.mockResolvedValue(status(false));
    backing.restoreStatus.mockResolvedValue(installation(false));
    backing.createWorkspaceBackup.mockResolvedValue({
      destinationPath: "/secure/backup-2",
      manifestHash: "c".repeat(64),
      databaseSha256: "d".repeat(64),
      artifactCount: 1,
      schemaVersion: 11,
      createdAt: 1,
      snapshot: status(true).lastBackup,
    });
    render(<BackupPanel factory={factory()} />);
    fireEvent.click(screen.getByRole("button", { name: /open backup controls/i }));
    await waitFor(() => expect(backing.backupStatus).toHaveBeenCalled());
    expect(screen.getByText(/Restorable: no/i)).toBeTruthy();
    expect(screen.getAllByText(/artifact_digest_mismatch/i).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(/destination bundle directory/i), {
      target: { value: "/secure/backup-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create backup$/i }));
    await waitFor(() =>
      expect(backing.createWorkspaceBackup).toHaveBeenCalledWith({
        destinationPath: "/secure/backup-2",
        actor: "operator",
      }),
    );
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  test("surfaces a held restored installation and records explicit reconciliation", async () => {
    backing.backupStatus.mockResolvedValue(status(true));
    backing.restoreStatus.mockResolvedValue(installation(true));
    backing.reconcileRestore.mockResolvedValue(installation(false));
    render(<BackupPanel factory={factory()} />);
    fireEvent.click(screen.getByRole("button", { name: /open backup controls/i }));

    await waitFor(() => expect(backing.restoreStatus).toHaveBeenCalled());
    expect(screen.getByText("restored installation held")).toBeTruthy();
    expect(screen.getByText(/Dispatch and publication are disabled/i)).toBeTruthy();
    expect(screen.getByText(/1 interrupted run\(s\)/i)).toBeTruthy();

    const runSelect = screen.getByLabelText(/Disposition for interrupted run 1/i);
    expect(runSelect.className).toContain("min-h-11");
    fireEvent.change(runSelect, { target: { value: "resolved" } });
    const intentSelect = screen.getByLabelText(/Disposition for pending publication intent 1/i);
    fireEvent.change(intentSelect, { target: { value: "abandoned" } });
    fireEvent.change(screen.getByLabelText(/reconciliation reason/i), {
      target: { value: "Verified owner identity cleared and remote intents read back" },
    });

    const reconcile = screen.getByRole("button", { name: /verify and release/i });
    expect(reconcile.className).toContain("min-h-11");
    fireEvent.click(reconcile);
    await waitFor(() =>
      expect(backing.reconcileRestore).toHaveBeenCalledWith({
        actor: "operator",
        reason: "Verified owner identity cleared and remote intents read back",
        snapshot: {
          sourceRestoreId: "restore_1",
          restoredAt: 1_700_000_000_000,
        },
        runs: [{ runId: "run_1", disposition: "resolved" }],
        intents: [{ intentId: "int_1", disposition: "abandoned" }],
      }),
    );
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});
