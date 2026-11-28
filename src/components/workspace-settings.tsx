import { Suspense, useState, type FormEvent } from "react";
import { FolderGit2, Pencil } from "lucide-react";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import { DiscardConfirm, useDiscardGuard } from "@/components/discard-guard";
import { Markdown } from "@/components/task-common";
import type { Workspace } from "@/lib/bindings";
import { useMessages } from "@/lib/i18n";
import { errorMessage } from "@/lib/error-messages";
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
  const m = useMessages();
  const copy = m.app.workspace;
  const updateWorkspace = useUpdateWorkspace();
  // Which field the open form focuses first: the name, or the repository when the form was
  // opened to set a missing one.
  const [editing, setEditing] = useState<false | "name" | "repository">(false);
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? "");
  const [repository, setRepository] = useState(workspace.repository ?? "");
  const changed =
    name !== workspace.name ||
    description !== (workspace.description ?? "") ||
    repository !== (workspace.repository ?? "");
  const guard = useDiscardGuard(changed, () => setEditing(false), updateWorkspace.isPending);

  function open(focus: "name" | "repository") {
    updateWorkspace.reset();
    setName(workspace.name);
    setDescription(workspace.description ?? "");
    setRepository(workspace.repository ?? "");
    setEditing(focus);
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
          {workspace.repository === null ? (
            // An empty repository is easy to miss, so it gets its own button rather than only
            // the edit form behind "Edit workspace".
            <Button
              size="sm"
              variant="secondary"
              label={copy.setRepository}
              icon={<FolderGit2 />}
              tooltip={copy.linkRepository}
              onClick={() => open("repository")}
            />
          ) : link === null ? (
              <code aria-label={copy.repository} className="truncate text-foreground">
                {workspace.repository}
              </code>
            ) : (
              <a
                aria-label={copy.repository}
                href={link}
                target="_blank"
                rel="noreferrer"
                className="truncate font-mono text-foreground underline underline-offset-2"
              >
                {workspace.repository}
              </a>
          )}
          <Button size="sm" variant="ghost" label={copy.edit} icon={<Pencil />} onClick={() => open("name")} />
        </p>
        {workspace.description !== null && (
          <Suspense fallback={<p className="whitespace-pre-wrap">{workspace.description}</p>}>
            <div aria-label={copy.workspaceDescription} className="text-sm">
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
      aria-label={copy.details}
      className="flex flex-col gap-1.5"
      onKeyDown={guard.onKeyDown}
    >
      <TextInput size="sm" label={copy.name} value={name} onChange={setName} hasAutoFocus={editing === "name"} />
      <TextArea size="sm" label={copy.optionalDescription} rows={4} value={description} onChange={setDescription} />
      <TextInput
        size="sm"
        label={copy.optionalRepository}
        hasSpellCheck={false}
        hasAutoFocus={editing === "repository"}
        value={repository}
        onChange={setRepository}
      />
      {guard.asking ? (
        <DiscardConfirm
          label={copy.discardLabel}
          question={copy.discardQuestion}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            label={m.common.save}
            isDisabled={updateWorkspace.isPending || name.trim() === ""}
          />
          <Button type="button" size="sm" variant="ghost" label={m.app.discard} onClick={guard.request} />
        </div>
      )}
      {updateWorkspace.isError && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(updateWorkspace.error, m)}
        </p>
      )}
    </form>
  );
}
