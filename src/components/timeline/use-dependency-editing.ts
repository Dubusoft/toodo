import { useMessages } from "@/lib/i18n";
import { useState } from "react";
import type { Connection, EdgeChange } from "@xyflow/react";
import type { Task, TaskId } from "@/lib/bindings";
import { useAddDependency, useRemoveDependency } from "@/lib/queries";
import { dependencyEditableStatuses, edgeId, type DependencyEdge } from "@/lib/task-graph";

export type Dependency = { id: TaskId; dependsOn: TaskId };

type DependencyError =
  | { readonly kind: "command"; readonly message: string }
  | { readonly kind: "removal"; readonly source: string; readonly target: string; readonly message: string };

/**
 * Dependencies drawn and removed on the timeline: the lines selected for removal, the lines
 * drawn onto started tasks that they would pause, held until the user confirms each, and why
 * the latest changes failed.
 */
export function useDependencyEditing(tasks: Task[], dependencies: DependencyEdge[]) {
  const m = useMessages();
  const addDependency = useAddDependency();
  const removeDependency = useRemoveDependency();
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  // Dependencies drawn onto started tasks that they would pause, confirmed one at a time in the
  // order they were drawn.
  const [confirmingEdges, setConfirmingEdges] = useState<Dependency[]>([]);
  // Why the latest dependency changes failed, one message per failed change.
  const [errors, setErrors] = useState<DependencyError[]>([]);
  const editable = (target: TaskId) =>
    dependencyEditableStatuses.includes(tasks.find((task) => task.id === target)?.status ?? "done");
  const failed = (error: Error) => setErrors((current) => [...current, { kind: "command", message: error.message }]);

  function connect({ source, target }: Connection) {
    const edge = { id: Number(target), dependsOn: Number(source) };
    setErrors([]);
    // The server tells whether the edge pauses a started task; then the user confirms it first.
    // Each call settles on its own promise: the callbacks of `mutate` run only for the latest of
    // several calls in flight, and a second edge drawn meanwhile would lose the first's outcome.
    addDependency.mutateAsync({ ...edge, confirmPause: false }).then((outcome) => {
      if (outcome === "confirm_pause") {
        setConfirmingEdges((queue) =>
          queue.some((queued) => queued.id === edge.id && queued.dependsOn === edge.dependsOn)
            ? queue
            : [...queue, edge],
        );
      }
    }, failed);
  }

  function dropConfirmation(edge: Dependency) {
    setConfirmingEdges((queue) => queue.filter((queued) => queued !== edge));
  }

  function confirmEdge(edge: Dependency) {
    setErrors([]);
    addDependency
      .mutateAsync({ ...edge, confirmPause: true })
      .catch(failed)
      .finally(() => dropConfirmation(edge));
  }

  /** Removes the edges together; those that fail stay selected, each with its error shown. */
  async function removeEdges(removed: { source: string; target: string }[]) {
    setErrors([]);
    const results = await Promise.allSettled(
      removed.map((edge) => removeDependency.mutateAsync({ id: Number(edge.target), dependsOn: Number(edge.source) })),
    );
    const ids = removed.map((edge) => edgeId(Number(edge.source), Number(edge.target)));
    setSelectedEdgeIds((current) => {
      const next = new Set(current);
      results.forEach((result, index) =>
        result.status === "rejected" ? next.add(ids[index]) : next.delete(ids[index]),
      );
      return next;
    });
    setErrors(
      results.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              { kind: "removal", ...removed[index], message: (result.reason as Error).message },
            ]
          : [],
      ),
    );
  }

  function selectEdges(changes: EdgeChange[]) {
    setSelectedEdgeIds((current) => {
      const next = new Set(current);
      for (const change of changes) {
        if (change.type === "select") {
          if (change.selected) {
            next.add(change.id);
          } else {
            next.delete(change.id);
          }
        }
      }
      return next;
    });
  }

  return {
    selectedEdgeIds,
    editable,
    /** The selected lines that can be removed. */
    removable: dependencies.filter((edge) => selectedEdgeIds.has(edge.id) && editable(edge.target)),
    changing: addDependency.isPending || removeDependency.isPending,
    errors: errors.map((error) => {
      switch (error.kind) {
        case "command": return error.message;
        case "removal": return m.details.graph.removeFailed(error.source, error.target, error.message);
      }
    }),
    connect,
    removeEdges,
    selectEdges,
    clearSelectedEdges: () => setSelectedEdgeIds(new Set()),
    /** The first drawn line waiting for the user to confirm the pause it causes. */
    confirmingEdge: confirmingEdges.at(0) ?? null,
    confirmPending: addDependency.isPending,
    confirmEdge,
    dropConfirmation,
  };
}
