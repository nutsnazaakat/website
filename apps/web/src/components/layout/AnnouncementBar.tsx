import { settings } from "@/config/settings";
import { inr } from "@/lib/format";

export function AnnouncementBar() {
  return (
    <div className="bg-foreground text-background flex flex-wrap items-center justify-center gap-[14px] px-5 py-[9px] text-[11px] font-semibold tracking-[0.2em] uppercase">
      <span>Small packs for home · Bulk supply for business</span>
      <span className="opacity-40" aria-hidden="true">
        —
      </span>
      <span className="text-gold-light">
        Free shipping on retail orders above {inr(settings.freeShippingThreshold)}
      </span>
    </div>
  );
}
