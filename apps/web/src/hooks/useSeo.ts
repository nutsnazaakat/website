import { useEffect } from "react";
import { applySeo, type SeoInput } from "@/lib/seo";

/**
 * Applies a route's meta tags. Routes build their SeoInput inline, so the object
 * identity changes on every render — the effect keys off the title and description
 * instead, which is what actually changes when a route's data resolves.
 */
export function useSeo(input: SeoInput) {
  const { title, description, canonical, ogImage, noindex } = input;
  const structured = JSON.stringify(input.jsonLd);

  useEffect(() => {
    applySeo(input);
    // `input` is rebuilt every render; title/description are the meaningful signal.
  }, [title, description, canonical, ogImage, noindex, structured]); // eslint-disable-line react-hooks/exhaustive-deps
}
