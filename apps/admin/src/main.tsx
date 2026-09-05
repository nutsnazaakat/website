import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders, createAppRouter } from "@/app/router";
import { createQueryClient } from "@/app/query-client";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("index.html is missing #root");

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders router={createAppRouter()} queryClient={createQueryClient()} />
  </StrictMode>,
);
