// Commands for the guidelines of a workspace: rules and memories that agents read before
// working on its tasks (`src-tauri/src/commands/guidelines.rs`).

import { guidelineId, workspaceId } from "../domain/model.ts";
import { command } from "./errors.ts";
import { guideline, guidelineBody, type Command } from "./types.ts";

/** The guidelines of a workspace: rules first, then memories, each in the order they were
 * added. */
export const listGuidelines: Command<"listGuidelines"> = command((storage, workspace) =>
  storage.listGuidelines(workspaceId(workspace)).map(guideline));

export const addGuideline: Command<"addGuideline"> = command((storage, input) =>
  guideline(storage.addGuideline({
    workspaceId: workspaceId(input.workspaceId),
    kind: input.kind,
    body: guidelineBody(input.body),
  })));

/** Replaces the kind and body of a guideline. */
export const updateGuideline: Command<"updateGuideline"> = command((storage, input) => {
  const body = guidelineBody(input.body);
  return guideline(storage.updateGuideline(guidelineId(input.id), input.kind, body));
});

/** Deletes a guideline and returns it as it was. */
export const deleteGuideline: Command<"deleteGuideline"> = command((storage, id) =>
  guideline(storage.deleteGuideline(guidelineId(id))));
