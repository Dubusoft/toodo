import { cn } from "@/lib/utils";

/**
 * Three dots that rise and brighten in turn: the app's sign of an agent at work, in the chat's
 * typing bubble and on a working lane. They take the text colour; the parent lays them out.
 * Reduced motion stills them, so the dots stay without moving.
 */
export function TypingDots({ className }: { className?: string }) {
  return [0, 150, 300].map((delay) => (
    <span
      key={delay}
      aria-hidden
      className={cn("rounded-full bg-current opacity-60 animate-typing-dot motion-reduce:animate-none", className)}
      style={{ animationDelay: `${delay}ms` }}
    />
  ));
}
