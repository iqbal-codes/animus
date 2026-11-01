import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadIssueDossier,
  recordLapAttempt,
  saveIssueDossier,
  syncDossierFindings,
  type IssueDossier,
} from "../../scripts/loop/dossier";

const meta = {
  issueNumber: 91,
  issueTitle: "Finding lifecycle",
  issueUrl: "https://github.com/example/repo/issues/91",
  branch: "delivery",
};
const attempt = {
  runId: "run-1",
  timestamp: "2026-11-01T00:00:00Z",
  status: "sent_back" as const,
  changedFiles: [],
  reviewFindings: [],
  qaFailures: [],
};
function fresh(): IssueDossier {
  return { ...meta, attempts: [] };
}
const finding = (title: string, id = "agent-local") => ({
  id,
  title,
  axis: "spec" as const,
  classification: "defect" as const,
  blocking: true,
  description: title,
  status: "open" as const,
  lapIntroduced: 0,
});

test("findings and monotonic host IDs survive subsequent lap records", () => {
  const root = mkdtempSync(join(tmpdir(), "animus-findings-"));
  try {
    const dossier = recordLapAttempt(root, meta, attempt);
    syncDossierFindings(dossier, [finding("C1 loses a saved record")]);
    saveIssueDossier(root, dossier);
    const next = recordLapAttempt(root, meta, { ...attempt, runId: "run-2" });
    expect(next.findings?.map((f) => f.id)).toEqual(["fnd-1"]);
    syncDossierFindings(next, [finding("New independent defect", "other-agent-id")]);
    saveIssueDossier(root, next);
    expect(loadIssueDossier(root, 91)?.findings?.map((f) => f.id)).toEqual(["fnd-1", "fnd-2"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("QA dispute dispositions cannot close code findings by substring or exact ID", () => {
  const dossier = fresh();
  syncDossierFindings(dossier, [finding("C1 loses saved data")]);
  syncDossierFindings(
    dossier,
    [],
    [
      { line: "C1", action: "rechecked", reason: "QA was mistaken" },
      { line: "fnd-1", action: "accepted", reason: "not a QA defect" },
    ],
  );
  expect(dossier.findings?.[0]?.status).toBe("open");
  expect(dossier.findings?.[0]?.blocking).toBe(true);
});

test("only fresh reviewer recheck evidence closes an existing finding", () => {
  const root = mkdtempSync(join(tmpdir(), "animus-recheck-"));
  try {
    const dossier = fresh();
    syncDossierFindings(dossier, [finding("Persisted defect")]);
    const rc = {
      findingId: "fnd-1",
      recheck: {
        recheckStatus: "resolved" as const,
        recheckCandidate: "old",
        recheckRole: "reviewer" as const,
        recheckEvidence: "recheck.log",
      },
    };
    writeFileSync(join(root, "recheck.log"), "Original trigger no longer loses saved data");
    syncDossierFindings(dossier, [], [], [rc], 1, { candidate: "new", artifactsDir: root });
    expect(dossier.findings?.[0]?.status).toBe("open");
    rc.recheck.recheckCandidate = "new";
    syncDossierFindings(dossier, [], [], [rc], 1, { candidate: "new", artifactsDir: root });
    expect(dossier.findings?.[0]?.status).toBe("rechecked_resolved");
    syncDossierFindings(dossier, [], [], [], 2, { candidate: "newer", artifactsDir: root });
    expect(dossier.findings?.[0]?.status).toBe("rechecked_resolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent supplied resolved state cannot close a new host finding", () => {
  const dossier = fresh();
  syncDossierFindings(dossier, [{ ...finding("Unverified fix"), status: "rechecked_resolved" }]);
  expect(dossier.findings?.[0]?.id).toBe("fnd-1");
  expect(dossier.findings?.[0]?.status).toBe("open");
});
