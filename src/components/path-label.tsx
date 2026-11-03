import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CopyState = "idle" | "copied" | "failed";

/** A short path with the full one in its tooltip and a button that copies the full path. */
export function PathLabel({
  label,
  full,
  short,
  className,
}: {
  label: string;
  full: string;
  short: string;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const reset = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(reset);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(full);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <span title={full} className={cn("truncate", className)}>
        {short}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Copy ${label}`}
        title={`Copy ${full}`}
        className="shrink-0 text-muted-foreground"
        onClick={() => void copy()}
      >
        {state === "copied" ? <Check /> : <Copy />}
      </Button>
      <span role="status" className={cn("shrink-0 text-xs", state === "failed" ? "text-destructive" : "sr-only")}>
        {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : ""}
      </span>
    </span>
  );
}
