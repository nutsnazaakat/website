import { Link } from "@tanstack/react-router";
import { Heart, Menu, Search, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetClose, SheetTitle } from "@/components/ui/sheet";
import { BrandMark } from "@/components/common/BrandMark";
import { useCart } from "@/features/cart/CartProvider";
import { useSearchDialog } from "@/features/catalog/SearchProvider";
import { useWishlist } from "@/features/wishlist/WishlistProvider";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/shop", label: "Shop" },
  { to: "/combos", label: "Combos" },
  { to: "/gifting", label: "Gifting" },
  { to: "/bulk-orders", label: "Bulk orders" },
  { to: "/quality", label: "Quality" },
  { to: "/about", label: "Our story" },
  { to: "/contact", label: "Contact" },
] as const;

const navClass =
  "text-[12px] font-semibold tracking-[0.12em] uppercase py-1.5 border-b-2 border-transparent hover:border-foreground hover:text-foreground";

export function SiteHeader() {
  const { count, setOpen } = useCart();
  const { slugs } = useWishlist();
  const saved = slugs.size;
  const { setOpen: setSearchOpen } = useSearchDialog();

  return (
    <header className="border-border bg-background sticky top-0 z-50 border-b">
      <div className="container-page flex items-center gap-6 py-3.5">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
              <Menu className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-6">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <BrandMark />
            <nav className="mt-8 flex flex-col gap-1">
              {nav.map((n) => (
                <SheetClose asChild key={n.to}>
                  <Link
                    key={n.to}
                    to={n.to}
                    className="hover:bg-sand px-2 py-2 text-[12px] font-semibold tracking-[0.12em] uppercase"
                  >
                    {n.label}
                  </Link>
                </SheetClose>
              ))}
            </nav>
          </SheetContent>
        </Sheet>

        <Link to="/" className="hover:text-foreground shrink-0" aria-label="Nuts & Nazaakat home">
          <BrandMark />
        </Link>

        <nav className="hidden items-center gap-4 lg:flex" aria-label="Main navigation">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className={navClass}
              activeProps={{ className: cn(navClass, "border-foreground") }}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search products"
            className="hidden sm:inline-flex"
            onClick={() => setSearchOpen(true)}
          >
            <Search className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" asChild>
            <Link
              to="/wishlist"
              aria-label={saved === 1 ? "Wishlist, 1 saved" : `Wishlist, ${saved} saved`}
            >
              <Heart className={cn("size-4", saved > 0 && "fill-foreground")} />
            </Link>
          </Button>
          <Button variant="ghost" size="icon" className="hidden sm:inline-flex" asChild>
            <Link to="/account" aria-label="Account">
              <User className="size-4" />
            </Link>
          </Button>
          <Button
            size="sm"
            className="hover:bg-gold hover:text-background"
            aria-label="Open cart"
            onClick={() => setOpen(true)}
          >
            Cart (<span>{count}</span>)
          </Button>
        </div>
      </div>
    </header>
  );
}
