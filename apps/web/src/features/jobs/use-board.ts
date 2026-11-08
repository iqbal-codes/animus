import { useCallback, useEffect, useState } from "react";
import type { OperatorBoard, Project } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { selectActiveProjects } from "@/features/drafts/drafts-model";

type BoardLoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; board: OperatorBoard | null };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the board projection from the same backend command/query API the CLI
 * uses. There is no local fixture store: empty, loading and error states are
 * real, and the selected project stays stable across refreshes.
 */
export function useOperatorBoard(factory: typeof client = client) {
  const [state, setState] = useState<BoardLoadState>({ phase: "loading" });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const nextProjects = await factory.projects();
      setProjects(nextProjects);
      const active = selectActiveProjects(nextProjects);
      const nextProjectId =
        (projectId && nextProjects.some((project) => project.id === projectId)
          ? projectId
          : null) ??
        active[0]?.id ??
        nextProjects[0]?.id ??
        null;
      setProjectId(nextProjectId);
      if (!nextProjectId) {
        setState({ phase: "ready", board: null });
        return;
      }
      const board = await factory.forProject(nextProjectId).board();
      setState({ phase: "ready", board });
    } catch (error) {
      setState({ phase: "error", message: messageOf(error) });
    }
  }, [factory, projectId]);

  useEffect(() => {
    void load();
    // Run once on mount; refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, projectId, projects, reload: load };
}
