import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export function PolicyTabs({ active }: { active: "shipping" | "returns" }) {
  const tab =
    "flex-1 px-4 py-2.5 text-center text-[12px] font-bold tracking-[0.14em] uppercase";
  return (
    <div className="border-foreground mb-8 flex max-w-[340px] border-[1.5px]">
      <Link
        to="/shipping"
        className={cn(
          tab,
          active === "shipping"
            ? "bg-foreground text-background hover:text-background"
            : "hover:bg-foreground hover:text-background",
        )}
      >
        Shipping
      </Link>
      <Link
        to="/returns"
        className={cn(
          tab,
          active === "returns"
            ? "bg-foreground text-background hover:text-background"
            : "hover:bg-foreground hover:text-background",
        )}
      >
        Returns
      </Link>
    </div>
  );
}
