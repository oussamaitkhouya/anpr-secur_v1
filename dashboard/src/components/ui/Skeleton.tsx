import { cn } from "../../lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("shimmer rounded-sm", className)} aria-hidden />;
}

/** Placeholder card body while data loads; announced once to screen readers. */
export function LoadingBlock({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <div role="status" aria-label={label} className={cn("space-y-3 p-6", className)}>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
