import { useState } from "react";
import { CatalogMedia } from "@/components/common/CatalogMedia";
import { cn } from "@/lib/utils";

interface ProductGalleryProps {
  images: string[];
  alt: string;
}

const DETAIL_CAPTIONS = ["detail — kernels", "pack back", "in the tin"];

export function ProductGallery({ images, alt }: ProductGalleryProps) {
  const [active, setActive] = useState(0);
  const main = images[Math.min(active, Math.max(images.length - 1, 0))];

  return (
    <div>
      <div className="border-border bg-sand border">
        <CatalogMedia src={main} alt={alt} />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        {DETAIL_CAPTIONS.map((caption, i) => {
          const src = images[i];
          const isMainSlot = i === 0 || i < images.length;
          return (
            <button
              key={caption}
              type="button"
              onClick={() => {
                if (isMainSlot && images.length > 0) setActive(Math.min(i, images.length - 1));
              }}
              aria-label={`Show image ${i + 1}`}
              aria-current={i === active}
              className={cn(
                "overflow-hidden border",
                i === active ? "border-foreground" : "border-border",
              )}
            >
              <CatalogMedia src={src} alt="" caption={caption} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
