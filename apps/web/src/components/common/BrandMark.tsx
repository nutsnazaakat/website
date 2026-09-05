import { cn } from "@/lib/utils";

export function BrandMark({ size = "header" }: { size?: "header" | "footer" }) {
  return (
    <span
      className={cn(
        "text-foreground flex flex-col font-black tracking-[-0.02em] uppercase",
        size === "header" ? "text-[13px] leading-[1.05]" : "text-[22px] leading-[1.02]",
      )}
    >
      <span>Nuts &amp;</span>
      <span>Nazaakat</span>
    </span>
  );
}
