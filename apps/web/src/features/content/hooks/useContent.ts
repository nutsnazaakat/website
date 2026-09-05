import { useQuery } from "@tanstack/react-query";
import { contentApi } from "../api";
import type { BlogCategory } from "../types";

export const contentKeys = {
  all: ["content"] as const,
  posts: (category: string) => [...contentKeys.all, "posts", category] as const,
  post: (slug: string) => [...contentKeys.all, "post", slug] as const,
  related: (slug: string) => [...contentKeys.all, "related", slug] as const,
};

export const usePosts = (category: BlogCategory | "all" = "all") =>
  useQuery({
    queryKey: contentKeys.posts(category),
    queryFn: () => contentApi.listPosts(category),
  });

export const usePost = (slug: string) =>
  useQuery({ queryKey: contentKeys.post(slug), queryFn: () => contentApi.getPost(slug) });

export const useRelatedPosts = (slug: string) =>
  useQuery({
    queryKey: contentKeys.related(slug),
    queryFn: () => contentApi.listRelatedPosts(slug),
  });
