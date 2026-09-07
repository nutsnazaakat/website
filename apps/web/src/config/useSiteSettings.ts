import { useQuery } from "@tanstack/react-query";
import { http } from "@/lib/http";
import { settings, type SiteSettings } from "./settings";

export function mergePublicSettings(raw: Record<string, unknown>): SiteSettings {
  const merged = { ...settings };
  for (const key of Object.keys(settings) as (keyof SiteSettings)[]) {
    const value = raw[key];
    const fallback = settings[key];
    if (typeof fallback === "string" && typeof value === "string")
      Object.assign(merged, { [key]: value });
    if (typeof fallback === "boolean" && typeof value === "boolean")
      Object.assign(merged, { [key]: value });
    if (
      typeof fallback === "number" &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
    )
      Object.assign(merged, { [key]: value });
    if (
      (key === "certifications" || key === "addressLines") &&
      Array.isArray(value) &&
      value.every((v) => typeof v === "string")
    )
      Object.assign(merged, { [key]: value });
    if (key === "social" && Array.isArray(value))
      merged.social = value.filter(
        (v): v is { label: string; url: string } =>
          !!v &&
          typeof v.label === "string" &&
          typeof v.url === "string" &&
          /^https:\/\//.test(v.url),
      );
  }
  return merged;
}

export function useSiteSettings() {
  const query = useQuery({
    queryKey: ["public-settings"],
    queryFn: () => http.get<Record<string, unknown>>("/settings").then(mergePublicSettings),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  return query.data ?? { ...settings, codEnabled: false, onlinePaymentEnabled: false };
}
