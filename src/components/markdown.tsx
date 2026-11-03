import { openUrl } from "@/web/opener";
import { Square, SquareCheck } from "lucide-react";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

// Only these open in the system browser; anything else (relative paths) stays plain text.
const external = /^(https?:|mailto:)/i;

function Link({ href, children }: { href?: string; children: ReactNode }) {
  if (!href || !external.test(href)) return <span>{children}</span>;
  // The WebView must never navigate away from the app, so clicks go to the opener plugin.
  const open = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    openUrl(href).catch((error: unknown) => console.error(`Failed to open ${href}`, error));
  };
  return (
    <a
      href={href}
      title={href}
      onClick={open}
      onAuxClick={open}
      className="text-primary underline underline-offset-2 hover:no-underline"
    >
      {children}
    </a>
  );
}

const heading = "text-sm font-semibold text-foreground";

// Descriptions come from users and agents; raw HTML is shown as text (react-markdown's
// default without rehype-raw) and images become links instead of remote fetches.
const components: Components = {
  h1: ({ children }) => <h4 className={heading}>{children}</h4>,
  h2: ({ children }) => <h4 className={heading}>{children}</h4>,
  h3: ({ children }) => <h5 className={heading}>{children}</h5>,
  h4: ({ children }) => <h5 className={heading}>{children}</h5>,
  h5: ({ children }) => <h6 className={heading}>{children}</h6>,
  h6: ({ children }) => <h6 className={heading}>{children}</h6>,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  img: ({ src, alt }) => <Link href={typeof src === "string" ? src : undefined}>{alt || src}</Link>,
  ul: ({ className, children }) => (
    <ul className={cn("list-disc pl-5", className === "contains-task-list" && "list-none pl-0.5")}>{children}</ul>
  ),
  ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
  input: ({ type, checked }) =>
    type === "checkbox" ? (
      <span role="img" aria-label={checked ? "Done" : "Not done"} className="mr-1.5 inline-block align-middle">
        {checked ? <SquareCheck className="size-4 text-foreground" /> : <Square className="size-4" />}
      </span>
    ) : null,
  blockquote: ({ children }) => <blockquote className="border-l-2 pl-3">{children}</blockquote>,
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
  hr: () => <hr className="border-border" />,
};

/** A task description rendered as GitHub-flavored Markdown. */
export default function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 break-words-keep text-sm text-muted-foreground", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
