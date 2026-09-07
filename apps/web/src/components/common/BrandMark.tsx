import { cn } from "@/lib/utils";

export function BrandMark({ size = "header" }: { size?: "header" | "footer" }) {
  return (
    <img
      src="/assets/nuts-nazaakat-logo.webp"
      alt="Nuts & Nazaakat — Premium Dry Fruits"
      width="600"
      height="304"
      className={cn(
        "object-cover mix-blend-multiply",
        size === "header" ? "h-[66px] w-[130px] sm:h-[78px] sm:w-[155px]" : "h-[110px] w-[220px]",
      )}
    />
  );
}
