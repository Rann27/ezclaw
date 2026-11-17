import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// Source-owned variants follow shadcn's Button API; native button behavior is preserved.
export const buttonVariants = cva("btn", {
  variants: {
    variant: {
      default: "btn-primary",
      outline: "btn-secondary",
      secondary: "btn-muted",
      ghost: "btn-ghost",
      destructive: "btn-danger",
      link: "btn-link",
    },
    size: {
      default: "",
      sm: "btn-sm",
      icon: "btn-icon",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export function Button({ className, variant, size, ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
