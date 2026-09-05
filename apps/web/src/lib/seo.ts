/**
 * TanStack Router runs in SPA mode here, so there is no `head()` hook to declare
 * meta from. Routes call `useSeo()` and this module writes the tags imperatively.
 */
export interface SeoInput {
  title: string;
  description: string;
  ogImage?: string;
  canonical?: string;
  jsonLd?: Record<string, unknown>;
  /** Signed-in surfaces (auth screens, the account area) must stay out of the index. */
  noindex?: boolean;
}

function upsertMeta(attr: "name" | "property", key: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export function applySeo({ title, description, ogImage, canonical, jsonLd, noindex }: SeoInput) {
  document.title = title;
  upsertMeta("name", "description", description);
  // Written on every route, not only the private ones: the tag is shared across
  // navigations, so a private page must not leave `noindex` behind on a public one.
  upsertMeta("name", "robots", noindex ? "noindex,nofollow" : "index,follow");
  upsertMeta("property", "og:title", title);
  upsertMeta("property", "og:description", description);
  if (ogImage) upsertMeta("property", "og:image", ogImage);

  let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "canonical";
    document.head.appendChild(link);
  }
  link.href = canonical ?? window.location.href;

  document.getElementById("route-jsonld")?.remove();
  if (jsonLd) {
    const script = document.createElement("script");
    script.id = "route-jsonld";
    script.type = "application/ld+json";
    script.textContent = JSON.stringify(jsonLd);
    document.head.appendChild(script);
  }
}
