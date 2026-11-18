import { Button as AstryxButton, type ButtonProps as AstryxButtonProps } from "@astryxdesign/core/Button";
import {
  IconButton as AstryxIconButton,
  type IconButtonProps as AstryxIconButtonProps,
} from "@astryxdesign/core/IconButton";
import { useCallback, useEffect, useRef, useSyncExternalStore, type Ref } from "react";
import { reachability, subscribeReachability } from "@/web/connection";

interface AppButtonProps {
  /**
   * Whether the button changes data on the server: such a button is disabled while the web app
   * cannot reach the server. Defaults to true for `type="submit"`, false otherwise.
   */
  changesData?: boolean;
  /** Focuses the button when it mounts, like the native attribute. */
  autoFocus?: boolean;
}

export type ButtonProps = AstryxButtonProps & AppButtonProps;
export type IconButtonProps = AstryxIconButtonProps & AppButtonProps;

function useAppButton({
  changesData,
  autoFocus,
  type,
  isDisabled,
  ref,
}: AppButtonProps & Pick<AstryxButtonProps, "type" | "isDisabled" | "ref">) {
  const state = useSyncExternalStore(subscribeReachability, reachability);
  const serverDown = state === "unreachable" || state === "retrying";
  const pausesWithServer = changesData ?? type === "submit";
  // Astryx does not pass autoFocus on to the element, so a button that appears in place of
  // another (a confirm step's "Back") is focused here.
  const element = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (autoFocus) element.current?.focus();
    // Only on mount, like the native attribute.
  }, []);
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      element.current = node;
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
    },
    [ref],
  );
  return { ref: setRef as Ref<HTMLButtonElement>, isDisabled: isDisabled || (pausesWithServer && serverDown) };
}

/**
 * The app's button: Astryx `Button` with every prop it takes, disabled while the server is
 * unreachable when it changes data (`changesData`, on by default for submit buttons), and
 * focused on mount with `autoFocus`.
 */
export function Button({ changesData, autoFocus, ...props }: ButtonProps) {
  return <AstryxButton {...props} {...useAppButton({ changesData, autoFocus, ...props })} />;
}

/** Astryx `IconButton` with the same app behavior as `Button`. */
export function IconButton({ changesData, autoFocus, ...props }: IconButtonProps) {
  return <AstryxIconButton {...props} {...useAppButton({ changesData, autoFocus, ...props })} />;
}
