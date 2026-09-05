import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { AnnouncementBar } from "@/components/layout/AnnouncementBar";
import { CartDrawer } from "@/components/layout/CartDrawer";
import { MobileTabBar } from "@/components/layout/MobileTabBar";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SearchDialog } from "@/features/catalog/components/SearchDialog";
import { SearchProvider } from "@/features/catalog/SearchProvider";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return (
    // SearchProvider wraps the layout rather than the app's provider stack so the header
    // and the mobile tab bar can both open one dialog without the test harness or
    // AppProviders needing to know about it.
    <SearchProvider>
      <div className="flex min-h-dvh flex-col">
        <AnnouncementBar />
        <SiteHeader />
        <main className="flex-1 pb-16 md:pb-0">
          <Outlet />
        </main>
        <SiteFooter />
        <MobileTabBar />
        <CartDrawer />
        <SearchDialog />
        <Toaster position="top-center" />
      </div>
    </SearchProvider>
  );
}

function NotFound() {
  return (
    <div className="container-page py-24 text-center">
      <p className="font-display text-5xl">404</p>
      <h1 className="font-display mt-4 text-2xl">This page has gone missing.</h1>
      <a href="/" className="mt-6 inline-block text-sm underline underline-offset-4">
        Back to home
      </a>
    </div>
  );
}
