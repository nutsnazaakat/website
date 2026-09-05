import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, body, action, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-8 py-20 text-center">
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <p className="font-display text-2xl">{title}</p>
      {body && <p className="text-muted-foreground max-w-sm text-sm">{body}</p>}
      {action}
    </div>
  );
}
