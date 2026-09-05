import type { AdminDashboard } from "@/contract";
import { http } from "@/lib/http";

/**
 * `GET /admin/dashboard` — brief §29's nine cards and four charts, computed in SQL.
 *
 * **It takes no parameters.** There is no `@Query()` on the handler, and because nothing is bound
 * there is no DTO to validate against — so an invented `?days=7` is silently ignored rather than
 * rejected, which is the worse of the two failures. The window is fixed server-side: the sales
 * series is the last 30 days (`SALES_SERIES_DAYS`) and the top lists are five entries each
 * (`TOP_SELLER_LIMIT`).
 *
 * **The dates are already in the business's timezone.** Plan 9.4 made it a `Settings` row
 * (`business.timezone`, default `Asia/Kolkata`) and `DashboardService.salesOverTime` buckets with
 * `AT TIME ZONE` before aggregating, so `AdminSalesPoint.date` is a business calendar day and not a
 * UTC one. Nothing in this app may re-derive it — see `businessDay` in `lib/format.ts` for the
 * `new Date("2026-08-21")` trap that would undo it.
 *
 * **The series is sparse**: only days that had orders appear. A chart that joined the points
 * without filling the gaps would draw a straight line across a quiet week and misreport it as
 * steady trade, so `fillSalesSeries` in the dashboard feature does the filling.
 */
export function fetchDashboard(signal?: AbortSignal): Promise<AdminDashboard> {
  return http.get<AdminDashboard>("/admin/dashboard", signal);
}
