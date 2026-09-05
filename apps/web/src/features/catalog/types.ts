/**
 * The catalogue domain types live in `@/contract` so the backend compiles against the
 * same shapes it must serve. This module remains as the import path components already use.
 */
export type {
  Badge,
  BulkTier,
  CatalogFacets,
  Category,
  Channel,
  Combo,
  ComboComponent,
  Product,
  ProductFilters,
  ProductSort,
  Seo,
  Variant,
} from "@/contract";
