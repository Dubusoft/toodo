import { lazy, Suspense, useId, useState } from "react";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { TextArea } from "@astryxdesign/core/TextArea";
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
      <SegmentedControl
        label={`Mode of ${label}`}
        size="sm"
        value={previewing ? "preview" : "write"}
        onChange={(mode) => setPreviewing(mode === "preview")}
      >
        <SegmentedControlItem value="write" label="Write" />
        <SegmentedControlItem value="preview" label="Preview" />
      </SegmentedControl>
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
        <TextArea
          rows={3}
          placeholder={placeholder}
          label={label}
          isLabelHidden
          aria-describedby={hint}
          value={value}
          onChange={onChange}
        />
      )}
      <p id={hint} className="text-xs text-muted-foreground">
        Markdown supported
      </p>
    </div>
  );
}
