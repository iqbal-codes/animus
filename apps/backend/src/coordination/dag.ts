import { CoordinationError } from "./errors";

export interface DagNode {
  number: number;
  dependencies: number[];
}

export function buildDependencyDAG(nodes: DagNode[]): Record<string, number[]> {
  const dag: Record<string, number[]> = {};
  const nodeMap = new Map<number, DagNode>();

  for (const n of nodes) {
    nodeMap.set(n.number, n);
    dag[String(n.number)] = [...n.dependencies];
  }

  // Cycle detection via DFS (3 colors: 0=unvisited, 1=visiting, 2=visited)
  const state = new Map<number, number>();

  function dfs(num: number, path: number[]): void {
    state.set(num, 1);
    const node = nodeMap.get(num);
    if (node) {
      for (const dep of node.dependencies) {
        if (!nodeMap.has(dep)) {
          // External dependency: allowed, not part of internal cycle check
          continue;
        }
        const s = state.get(dep) ?? 0;
        if (s === 1) {
          throw new CoordinationError(
            "dependency_cycle_detected",
            `Cyclic dependency detected: ${[...path, num, dep].join(" -> ")}`,
            { cycle: [...path, num, dep] },
          );
        }
        if (s === 0) {
          dfs(dep, [...path, num]);
        }
      }
    }
    state.set(num, 2);
  }

  for (const n of nodes) {
    if ((state.get(n.number) ?? 0) === 0) {
      dfs(n.number, []);
    }
  }

  return dag;
}

export function getUnblockedChildren(
  nodes: DagNode[],
  satisfiedDependencies: Set<number>,
  pendingStatuses: Set<number>,
): number[] {
  const unblocked: number[] = [];
  for (const node of nodes) {
    if (!pendingStatuses.has(node.number)) {
      continue;
    }
    const allSatisfied = node.dependencies.every((dep) => satisfiedDependencies.has(dep));
    if (allSatisfied) {
      unblocked.push(node.number);
    }
  }
  return unblocked;
}

export function computeTopologicalWaves(nodes: DagNode[]): number[][] {
  buildDependencyDAG(nodes); // ensures no cycles

  const remaining = new Map<number, Set<number>>();
  for (const n of nodes) {
    // Only track internal dependencies
    const internalDeps = n.dependencies.filter((d) => nodes.some((other) => other.number === d));
    remaining.set(n.number, new Set(internalDeps));
  }

  const waves: number[][] = [];
  const completed = new Set<number>();

  while (remaining.size > 0) {
    const currentWave: number[] = [];
    for (const [num, deps] of remaining.entries()) {
      let ready = true;
      for (const d of deps) {
        if (!completed.has(d)) {
          ready = false;
          break;
        }
      }
      if (ready) {
        currentWave.push(num);
      }
    }

    if (currentWave.length === 0) {
      // Should not happen if buildDependencyDAG passed, but fail safe
      throw new CoordinationError(
        "dependency_resolution_stuck",
        "Unresolvable dependencies in DAG",
      );
    }

    for (const num of currentWave) {
      remaining.delete(num);
      completed.add(num);
    }

    waves.push(currentWave.sort((a, b) => a - b));
  }

  return waves;
}
