import { useCallback, useEffect, useState } from "react";
import type { OperatorBoard, Project } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { selectActiveProjects } from "@/features/drafts/drafts-model";
import { ALL_PROJECTS_ID } from "./jobs-model";

type BoardLoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; board: OperatorBoard | null; boards: OperatorBoard[] };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the board projection from the same backend command/query API the CLI
 * uses. Supports both single-repository selection and aggregated "All
 * repositories" view across active projects.
 */
export function useOperatorBoard(factory: typeof client = client) {
  const [state, setState] = useState<BoardLoadState>({ phase: "loading" });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  const load = useCallback(
    async (targetProjectId?: string | null) => {
      setState({ phase: "loading" });
      try {
        const nextProjects = await factory.projects();
        setProjects(nextProjects);
        const active = selectActiveProjects(nextProjects);
        const chosenId = targetProjectId !== undefined ? targetProjectId : projectId;

        if (chosenId === ALL_PROJECTS_ID) {
          setProjectId(ALL_PROJECTS_ID);
          const targets = active.length > 0 ? active : nextProjects;
          if (targets.length === 0) {
            setState({ phase: "ready", board: null, boards: [] });
            return;
          }
          const boards = await Promise.all(
            targets.map((project) => factory.forProject(project.id).board()),
          );
          setState({ phase: "ready", board: null, boards });
          return;
        }

        const nextProjectId =
          (chosenId && nextProjects.some((project) => project.id === chosenId) ? chosenId : null) ??
          active[0]?.id ??
          nextProjects[0]?.id ??
          null;
        setProjectId(nextProjectId);
        if (!nextProjectId) {
          setState({ phase: "ready", board: null, boards: [] });
          return;
        }
        const board = await factory.forProject(nextProjectId).board();
        setState({ phase: "ready", board, boards: [board] });
      } catch (error) {
        setState({ phase: "error", message: messageOf(error) });
      }
    },
    [factory, projectId],
  );

  const selectProject = useCallback(
    async (id: string) => {
      setProjectId(id);
      await load(id);
    },
    [load],
  );

  useEffect(() => {
    void load();
    // Run once on mount; refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, projectId, projects, reload: load, selectProject };
}
