import type { ReactNode } from "react";

/**
 * Every screen's frame: a sticky header and a scrolling body.
 *
 * The header stays put because the console's screens are long and the thing an operator needs to
 * find their way back from a scrolled position is the title and the actions beside it, not the
 * first row of a table.
 */
export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-border bg-background sticky top-0 z-10 flex items-center justify-between gap-4 border-b px-4 py-2.5">
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold">{title}</h1>
          {description !== undefined && (
            <p className="text-muted-foreground truncate text-[11px]">{description}</p>
          )}
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="flex-1 p-4">{children}</div>
    </div>
  );
}
