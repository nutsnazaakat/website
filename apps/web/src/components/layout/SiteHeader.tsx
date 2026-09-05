import { Link } from "@tanstack/react-router";
import { Heart, Menu, Search, ShoppingBag, User } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useCart } from "@/features/cart/CartProvider";
import { useSearchDialog } from "@/features/catalog/SearchProvider";
import { useWishlist } from "@/features/wishlist/WishlistProvider";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/shop", label: "Shop" },
  { to: "/combos", label: "Combos" },
  { to: "/bulk-orders", label: "Bulk Orders" },
  { to: "/gifting", label: "Gifting" },
  { to: "/about", label: "Our Story" },
] as const;

export function SiteHeader() {
  const { count, setOpen } = useCart();
  const { setOpen: setSearchOpen } = useSearchDialog();
  const { count: savedCount } = useWishlist();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "border-border/70 bg-background/85 sticky top-0 z-50 border-b backdrop-blur transition-all",
        scrolled ? "py-1" : "py-3",
      )}
    >
      <div className="container-page flex items-center gap-4">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
              <Menu className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-6">
            <nav className="mt-8 flex flex-col gap-1 text-lg">
              {nav.map((n) => (
                <Link key={n.to} to={n.to} className="hover:bg-accent rounded-md px-2 py-2">
                  {n.label}
                </Link>
              ))}
            </nav>
          </SheetContent>
        </Sheet>

        <Link to="/" className="flex items-baseline gap-1.5">
          <span className="font-display text-2xl">Nuts &amp; Nazaakat</span>
          <span className="text-muted-foreground hidden text-[10px] font-semibold tracking-[0.22em] uppercase sm:inline">
            Dry Fruits
          </span>
        </Link>

        <nav className="ml-6 hidden items-center gap-6 text-sm font-medium md:flex">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="text-muted-foreground hover:text-foreground transition-colors"
              activeProps={{ className: "text-foreground" }}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          {/* Brief §22 — opens the instant-search dialog rather than navigating to the
              shop page. The keyboard hint is desktop-only; ⌘K works either way. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search products"
            onClick={() => setSearchOpen(true)}
          >
            <Search className="size-5" />
          </Button>
          {/* asChild so each renders a single <a>. Nesting <button> inside <a> is invalid
              HTML and gives one action two focusable stops. */}
          <Button variant="ghost" size="icon" className="hidden sm:inline-flex" asChild>
            <Link to="/account" aria-label="Account">
              <User className="size-5" />
            </Link>
          </Button>
          {/*
           * A link to the page, not a second drawer: one saved list, one place it lives. The count
           * is in the accessible name rather than only in the badge, or the number is invisible to
           * anyone not looking at the superscript.
           */}
          <Button variant="ghost" size="icon" asChild>
            <Link
              to="/wishlist"
              aria-label={savedCount > 0 ? `Wishlist, ${String(savedCount)} saved` : "Wishlist"}
            >
              <span className="relative">
                <Heart className="size-5" />
                {savedCount > 0 && (
                  <span className="bg-primary text-primary-foreground absolute -top-2 -right-2 grid size-4 place-items-center rounded-full text-[10px] font-bold">
                    {savedCount}
                  </span>
                )}
              </span>
            </Link>
          </Button>
          <Button variant="ghost" size="icon" aria-label="Open cart" onClick={() => setOpen(true)}>
            <span className="relative">
              <ShoppingBag className="size-5" />
              {count > 0 && (
                <span className="bg-primary text-primary-foreground absolute -top-2 -right-2 grid size-4 place-items-center rounded-full text-[10px] font-bold">
                  {count}
                </span>
              )}
            </span>
          </Button>
          <Button size="sm" className="ml-2 hidden lg:inline-flex" asChild>
            <Link to="/bulk-orders">Buy in Bulk</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
