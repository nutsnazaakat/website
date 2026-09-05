
/**
 * Brief §28's editorial categories and both blog wire shapes live in `@/contract`, so the backend's
 * DTOs and this module cannot disagree. Re-exported here because the content API, hooks and routes
 * already import them from this path.
 *
 * **`BlogPost` used to be declared here, and that was the drift the contract exists to prevent.**
 * The local copy carried `body` and `readingMinutes` on *every* post, which is what the mock
 * returned; the server's list answers `BlogPostSummary`, which has neither `body` nor — until this
 * change — `readingMinutes`. Two shapes, both compiling, disagreeing about what a list item holds.
 * The local declaration is gone; `@/contract` is the only definition.
 */
export { BLOG_CATEGORIES } from "@/contract";
export type { BlogCategory, BlogPost, BlogPostSummary } from "@/contract";
