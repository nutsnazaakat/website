import { format } from "date-fns";
import { ORDER_STATUS_LABEL, isTimelineComplete } from "../status";
import type { OrderEvent } from "../types";
import { cn } from "@/lib/utils";

/**
 * The order's own history, oldest first — not a fixed nine-step ladder. A cancelled
 * order never reaches "shipped", and drawing greyed-out steps it will never reach
 * would tell the customer to keep waiting for something that is not coming.
 */
export function OrderTimeline({ events }: { events: OrderEvent[] }) {
  const last = events.length - 1;

  return (
    <ol aria-label="Status timeline" className="space-y-5">
      {events.map((e, i) => {
        const current = i === last;
        return (
          <li key={`${e.status}-${e.at}`} className="relative flex gap-4 pl-1">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "mt-1 size-3 shrink-0 rounded-full border-2",
                  current ? "border-leaf bg-leaf" : "border-border bg-background",
                )}
                aria-hidden="true"
              />
              {i < last && <span className="bg-border mt-1 w-px flex-1" aria-hidden="true" />}
            </div>

            <div className="pb-1">
              <p className={cn("text-sm", current && "font-semibold")}>
                {ORDER_STATUS_LABEL[e.status]}
                {current && !isTimelineComplete(e.status) && (
                  <span className="text-muted-foreground ml-2 text-xs font-normal">
                    current step
                  </span>
                )}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {format(new Date(e.at), "d MMM yyyy, h:mm a")}
              </p>
              {e.note && <p className="text-muted-foreground mt-1 text-sm">{e.note}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
