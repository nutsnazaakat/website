import { Link } from "@tanstack/react-router";
import { Home, Package, Search, ShoppingBag, Warehouse } from "lucide-react";
import { useCart } from "@/features/cart/CartProvider";
import { useSearchDialog } from "@/features/catalog/SearchProvider";

export function MobileTabBar() {
  const { count, setOpen } = useCart();
  const { setOpen: setSearchOpen } = useSearchDialog();
  const item = "flex flex-1 flex-col items-center gap-1 py-2 text-[11px] text-muted-foreground";

  return (
    <nav className="border-border bg-background/95 fixed inset-x-0 bottom-0 z-40 flex border-t backdrop-blur md:hidden">
      <Link to="/" className={item} activeProps={{ className: `${item} text-foreground` }}>
        <Home className="size-5" />
        Home
      </Link>
      <Link to="/shop" className={item} activeProps={{ className: `${item} text-foreground` }}>
        <Package className="size-5" />
        Shop
      </Link>
      {/* Brief §22 and §40 — the Search tab opens the same instant-search dialog the
          header does, rather than sending the visitor to the shop page to find a field. */}
      <button type="button" className={item} onClick={() => setSearchOpen(true)}>
        <Search className="size-5" />
        Search
      </button>
      <Link
        to="/bulk-orders"
        className={item}
        activeProps={{ className: `${item} text-foreground` }}
      >
        <Warehouse className="size-5" />
        Bulk
      </Link>
      <button className={item} onClick={() => setOpen(true)}>
        <span className="relative">
          <ShoppingBag className="size-5" />
          {count > 0 && (
            <span className="bg-primary text-primary-foreground absolute -top-1.5 -right-2 grid size-4 place-items-center rounded-full text-[10px] font-bold">
              {count}
            </span>
          )}
        </span>
        Cart
      </button>
    </nav>
  );
}
