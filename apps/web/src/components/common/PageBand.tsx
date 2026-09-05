import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageBandProps {
  kicker?: string;
  title: ReactNode;
  intro?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function PageBand({ kicker, title, intro, children, className }: PageBandProps) {
  return (
    <section className="border-border bg-sand border-b">
      <div className={cn("container-page py-16", className)}>
        {kicker && <p className="kicker mb-5">{kicker}</p>}
        <h1 className="page-h1 max-w-[760px]">{title}</h1>
        {intro && <div className="text-body mt-4 max-w-2xl text-[16px] leading-[1.65]">{intro}</div>}
        {children}
      </div>
    </section>
  );
}
