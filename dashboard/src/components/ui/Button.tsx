import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "gold";

const VARIANTS: Record<Variant, string> = {
  primary: "btn-primary",
  secondary: "border border-border bg-surface/70 text-text shadow-1 backdrop-blur hover:border-border-strong hover:bg-bg-subtle",
  ghost: "text-muted hover:bg-bg-subtle hover:text-text",
  danger: "border border-danger bg-danger-soft text-danger hover:brightness-95",
  gold: "border border-gold bg-gold-soft text-gold-strong hover:brightness-95",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
}>(function Button({ variant = "secondary", size = "md", loading, className, children, disabled, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        "focus-ring inline-flex items-center justify-center gap-2 rounded-sm font-medium transition-[background-color,border-color,filter,color,transform] duration-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-55",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 size={15} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
});
