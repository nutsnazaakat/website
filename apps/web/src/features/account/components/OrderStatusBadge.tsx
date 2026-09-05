import { Badge } from "@/components/ui/badge";
import { ORDER_STATUS_LABEL, ORDER_STATUS_VARIANT } from "../status";
import type { OrderStatus } from "../types";

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge variant={ORDER_STATUS_VARIANT[status]}>{ORDER_STATUS_LABEL[status]}</Badge>;
}
