import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One numbered step of the checkout ladder.
 *
 * It lives here, beside the sections, rather than in `@/components/common`: the numbered chip is a
 * checkout idea — the steps renumber on `isB2b`, which no other screen has — and every importer is a
 * file in this directory. A `components/common` home would advertise it to screens whose headings
 * are `SectionHeading`.
 */
export function Section({
  title,
  step,
  children,
  className,
}: {
  title: string;
  step: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-border rounded-2xl border p-5 sm:p-6", className)}>
      <h2 className="font-display flex items-center gap-3 text-2xl">
        <span className="bg-sand grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold">
          {step}
        </span>
        {title}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}
