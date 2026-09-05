import { useState } from "react";
import { cn } from "@/lib/utils";

interface ProductGalleryProps {
  images: string[];
  alt: string;
}

export function ProductGallery({ images, alt }: ProductGalleryProps) {
  const [active, setActive] = useState(0);
  const main = images[Math.min(active, images.length - 1)];

  return (
    <div>
      <div className="border-border bg-sand overflow-hidden rounded-3xl border">
        {main && (
          <img
            src={main}
            alt={alt}
            width={1200}
            height={1200}
            className="aspect-square w-full object-cover"
          />
        )}
      </div>

      {images.length > 1 && (
        <div className="mt-4 flex gap-3">
          {images.map((src, i) => (
            <button
              key={`${src}-${i}`}
              type="button"
              onClick={() => setActive(i)}
              aria-label={`Show image ${i + 1} of ${images.length}`}
              aria-current={i === active}
              className={cn(
                "bg-sand size-16 overflow-hidden rounded-xl border transition-colors sm:size-20",
                i === active ? "border-primary" : "border-border hover:border-primary/50",
              )}
            >
              <img
                src={src}
                alt=""
                loading="lazy"
                width={160}
                height={160}
                className="size-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
