import type { ReactNode } from "react";

interface SectionHeadingProps {
  title: string;
  body?: string;
  action?: ReactNode;
}

export function SectionHeading({ title, body, action }: SectionHeadingProps) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h2 className="font-display text-3xl">{title}</h2>
        {body && <p className="text-muted-foreground mt-2 text-sm">{body}</p>}
      </div>
      {action}
    </div>
  );
}
