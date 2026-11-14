import React, { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import type { IntakePublishResult, Project } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ALL_PROJECTS_ID } from "./jobs-model";

export interface NewJobModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  currentProjectId?: string | null;
  factory?: typeof client;
  onCreated?: (result: IntakePublishResult) => void;
}

type InitialLabel = "needs-triage" | "ready-for-agent";

/**
 * Modal form for creating a new job/issue in a selected repository via the
 * canonical project intake publish endpoint.
 */
export function NewJobModal({
  open,
  onOpenChange,
  projects,
  currentProjectId,
  factory = client,
  onCreated,
}: NewJobModalProps) {
  const selectableProjects = useMemo(
    () => projects.filter((project) => project.status !== "tombstone"),
    [projects],
  );

  const defaultProjectId = useMemo(() => {
    if (
      currentProjectId &&
      currentProjectId !== ALL_PROJECTS_ID &&
      selectableProjects.some((project) => project.id === currentProjectId)
    ) {
      return currentProjectId;
    }
    return (
      selectableProjects.find((project) => project.status === "active")?.id ??
      selectableProjects[0]?.id ??
      ""
    );
  }, [currentProjectId, selectableProjects]);

  const [targetProjectId, setTargetProjectId] = useState(defaultProjectId);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [initialLabel, setInitialLabel] = useState<InitialLabel>("needs-triage");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTargetProjectId(defaultProjectId);
      setTitle("");
      setBody("");
      setInitialLabel("needs-triage");
      setSubmitting(false);
      setError(null);
    }
  }, [open, defaultProjectId]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!targetProjectId) {
      setError("Select a repository first.");
      return;
    }
    if (!trimmedTitle) {
      setError("Job title is required.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await factory.forProject(targetProjectId).publishTicket({
        title: trimmedTitle,
        body: body.trim(),
        labels: [initialLabel],
      });
      onCreated?.(result);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>
            Create a tracked issue in the repository backlog for Animus to triage or pick up.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-job-project">Repository</Label>
            <select
              id="new-job-project"
              value={targetProjectId}
              onChange={(event) => setTargetProjectId(event.target.value)}
              disabled={submitting || selectableProjects.length === 0}
              className="h-9 w-full rounded-[var(--radius-input)] border border-[var(--input)] bg-background px-3 text-xs text-foreground outline-none focus-visible:border-[var(--ring)]"
            >
              {selectableProjects.length === 0 && (
                <option value="">No repositories available</option>
              )}
              {selectableProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.repo_name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-job-title">Title</Label>
            <Input
              id="new-job-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g., Fix OAuth callback redirect on mobile"
              disabled={submitting}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-job-body">Description &amp; acceptance criteria</Label>
            <Textarea
              id="new-job-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Describe the goal, constraints, or acceptance criteria…"
              rows={4}
              disabled={submitting}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-job-stage">Initial admission stage</Label>
            <select
              id="new-job-stage"
              value={initialLabel}
              onChange={(event) => setInitialLabel(event.target.value as InitialLabel)}
              disabled={submitting}
              className="h-9 w-full rounded-[var(--radius-input)] border border-[var(--input)] bg-background px-3 text-xs text-foreground outline-none focus-visible:border-[var(--ring)]"
            >
              <option value="needs-triage">Triage (needs-triage)</option>
              <option value="ready-for-agent">Ready for agent (ready-for-agent)</option>
            </select>
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[var(--radius-news)] border border-[var(--error)]/40 bg-[var(--error-bg)] px-3 py-2 text-xs text-[var(--error)]"
            >
              <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !targetProjectId || !title.trim()}>
              {submitting && <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />}
              {submitting ? "Creating…" : "Create job"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
