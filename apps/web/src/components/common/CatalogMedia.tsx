import { cn } from "@/lib/utils";

export function isCatalogPlaceholder(src: string | undefined): boolean {
  return !src || src.includes("placehold.co");
}

interface CatalogMediaProps {
  src?: string;
  alt: string;
  caption?: string;
  className?: string;
}

export function CatalogMedia({ src, alt, caption, className }: CatalogMediaProps) {
  if (!isCatalogPlaceholder(src)) {
    return (
      <img
        src={src}
        alt={alt}
        loading="lazy"
        width={800}
        height={800}
        className={cn("aspect-square w-full object-cover", className)}
      />
    );
  }

  return (
    <div
      className={cn(
        "stripe-placeholder flex aspect-square items-center justify-center p-4 text-center",
        className,
      )}
    >
      <span className="text-kicker font-mono text-[10px] leading-[1.5]">
        {caption ?? `pack shot — ${alt} (800 × 800)`}
      </span>
    </div>
  );
}
