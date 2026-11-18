import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/button";

/** The fields of a form that take typed or picked values, Astryx selectors included. */
const fields = "input, textarea, select, [role=combobox]";

/**
 * Closing of an inline form that may hold typed text: `request` closes a clean form at once
 * and asks first when it is `dirty`; Escape inside the form does the same, or goes back to the
 * form while the question is shown, focusing the field that was being edited. Escape does
 * nothing while the form is `busy`. The question's discard goes through `discard`, so a form
 * that is opened again does not start out asking.
 */
export function useDiscardGuard(dirty: boolean, close: () => void, busy = false) {
  const [asking, setAsking] = useState(false);
  const editedField = useRef<HTMLElement | null>(null);
  const request = () => {
    if (!dirty) {
      close();
      return;
    }
    editedField.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAsking(true);
  };
  const keep = (from: EventTarget | null) => {
    const field = editedField.current;
    if (field?.isConnected && field.matches(fields)) {
      field.focus();
    } else {
      const form = from instanceof Element ? from.closest("form") : null;
      form?.querySelector<HTMLElement>("textarea, input:not([type=checkbox]), select, [role=combobox]")?.focus();
    }
    setAsking(false);
  };
  const discard = () => {
    setAsking(false);
    close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || busy || event.defaultPrevented) return;
    // Escape in an open selector closes its option list, not the form.
    if (event.target instanceof Element && event.target.closest("[role=listbox], [aria-expanded=true]")) return;
    event.preventDefault();
    if (asking) keep(event.target);
    else request();
  };
  return { asking, request, keep, discard, onKeyDown };
}

/** The question shown in place of a form's buttons before its typed text is thrown away. */
export function DiscardConfirm({
  label,
  question,
  onKeep,
  onDiscard,
}: {
  label: string;
  question: string;
  onKeep: (from: EventTarget | null) => void;
  onDiscard: () => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1 text-xs max-md:gap-2">
      <span className="mr-1">{question}</span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        label="Keep editing"
        autoFocus
        onClick={(event) => onKeep(event.currentTarget)}
      />
      <Button type="button" size="sm" variant="destructive" label="Discard changes" onClick={onDiscard} />
    </div>
  );
}
