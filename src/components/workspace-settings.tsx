import { Suspense, useState, type FormEvent } from "react";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import { DiscardConfirm, useDiscardGuard } from "@/components/discard-guard";
import { Markdown } from "@/components/task-common";
import type { Workspace } from "@/lib/bindings";
import { useUpdateWorkspace } from "@/lib/queries";

/** The link a repository reference points to: a URL as it is, `owner/repo` on GitHub; `null` for anything else. */
export function repositoryUrl(repository: string): string | null {
  if (/^https?:\/\/\S+$/.test(repository)) return repository;
  return /^[\w.-]+\/[\w.-]+$/.test(repository) ? `https://github.com/${repository}` : null;
}

/**
 * The description and repository reference of a workspace, with a form that edits them and
 * its name.
 */
export function WorkspaceDetails({ workspace }: { workspace: Workspace }) {
  const updateWorkspace = useUpdateWorkspace();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? "");
  const [repository, setRepository] = useState(workspace.repository ?? "");
  const changed =
    name !== workspace.name ||
    description !== (workspace.description ?? "") ||
    repository !== (workspace.repository ?? "");
  const guard = useDiscardGuard(changed, () => setEditing(false), updateWorkspace.isPending);

  function open() {
    updateWorkspace.reset();
    setName(workspace.name);
    setDescription(workspace.description ?? "");
    setRepository(workspace.repository ?? "");
    setEditing(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateWorkspace.mutate(
      {
        ...workspace,
        name: name.trim(),
        description: description.trim() || null,
        repository: repository.trim() || null,
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  if (!editing) {
    const link = workspace.repository === null ? null : repositoryUrl(workspace.repository);
    return (
      <div className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">
        <p className="flex min-w-0 items-center gap-1 max-md:flex-wrap">
          {workspace.repository !== null &&
            (link === null ? (
              <code aria-label="Repository" className="truncate text-foreground">
                {workspace.repository}
              </code>
            ) : (
              <a
                aria-label="Repository"
                href={link}
                target="_blank"
                rel="noreferrer"
                className="truncate font-mono text-foreground underline underline-offset-2"
              >
                {workspace.repository}
              </a>
            ))}
          <Button size="sm" variant="ghost" label="Edit workspace" onClick={open}>
            Edit
          </Button>
        </p>
        {workspace.description !== null && (
          <Suspense fallback={<p className="whitespace-pre-wrap">{workspace.description}</p>}>
            <div aria-label="Workspace description" className="text-sm">
              <Markdown source={workspace.description} />
            </div>
          </Suspense>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Workspace details"
      className="flex flex-col gap-1.5"
      onKeyDown={guard.onKeyDown}
    >
      <TextInput size="sm" label="Name" value={name} onChange={setName} hasAutoFocus />
      <TextArea size="sm" label="Description (optional, Markdown)" rows={4} value={description} onChange={setDescription} />
      <TextInput
        size="sm"
        label="Repository (optional, e.g. owner/repo or a URL)"
        hasSpellCheck={false}
        value={repository}
        onChange={setRepository}
      />
      {guard.asking ? (
        <DiscardConfirm
          label="Discard workspace changes"
          question="Discard the changes to the workspace?"
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            label="Save"
            isDisabled={updateWorkspace.isPending || name.trim() === ""}
          />
          <Button type="button" size="sm" variant="ghost" label="Discard" onClick={guard.request} />
        </div>
      )}
      {updateWorkspace.isError && (
        <p role="alert" className="text-xs text-destructive">
          {updateWorkspace.error.message}
        </p>
      )}
    </form>
  );
}
