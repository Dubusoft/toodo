import { lazy, Suspense, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/workspace-list";
import { cn } from "@/lib/utils";

const Markdown = lazy(() => import("@/components/markdown"));

/** A Markdown description field with Write and Preview modes. */
export function MarkdownEditor({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [previewing, setPreviewing] = useState(false);
  const hint = useId();

  return (
    <div className={cn("flex min-w-0 flex-col gap-1 max-md:gap-2", className)}>
      <div role="group" aria-label={`Mode of ${label}`} className="flex gap-0.5 max-md:gap-2">
        <Button type="button" size="xs" variant={previewing ? "ghost" : "default"} aria-pressed={!previewing} onClick={() => setPreviewing(false)}>
          Write
        </Button>
        <Button type="button" size="xs" variant={previewing ? "default" : "ghost"} aria-pressed={previewing} onClick={() => setPreviewing(true)}>
          Preview
        </Button>
      </div>
      {previewing ? (
        <div
          role="region"
          aria-label={`Preview of ${label}`}
          className="min-h-16 rounded-lg border border-input px-2.5 py-1.5"
        >
          {value.trim() ? (
            <Suspense fallback={<p className="whitespace-pre-line break-words-keep text-sm text-muted-foreground">{value}</p>}>
              <Markdown source={value} />
            </Suspense>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing to preview</p>
          )}
        </div>
      ) : (
        <textarea
          className={cn(inputClass, "h-auto min-h-16 resize-y py-1.5 max-md:h-auto")}
          rows={3}
          placeholder={placeholder}
          aria-label={label}
          aria-describedby={hint}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <p id={hint} className="text-xs text-muted-foreground">
        Markdown supported
      </p>
    </div>
  );
}
