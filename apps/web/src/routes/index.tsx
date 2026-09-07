import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, PackageCheck, Gift, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { ProductCard } from "@/features/catalog/components/ProductCard";
import { useBestsellers } from "@/features/catalog/hooks/useCatalog";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/")({ component: Home });

const categories = [
  {
    slug: "cashews",
    name: "Cashews",
    note: "A little crunch. A lot of character.",
    image: "/assets/cat-cashews.jpg",
  },
  {
    slug: "almonds",
    name: "Almonds",
    note: "The everyday essential, elevated.",
    image: "/assets/cat-almonds.jpg",
  },
  {
    slug: "pistachios",
    name: "Pistachios",
    note: "Made for one more handful.",
    image: "/assets/cat-pistachios.jpg",
  },
];

function Home() {
  useSeo({
    title: "Nuts & Nazaakat | A little crunch. A little elegance.",
    description:
      "Discover cashews, almonds, pistachios and thoughtful dry-fruit gifts from Nuts & Nazaakat. Shop your everyday favourites or enquire about gifting and bulk orders.",
  });
  const featured = useBestsellers(4);
  return (
    <div>
      <section className="brand-hero">
        <div className="brand-hero-copy">
          <p className="eyebrow">THE ART OF A GOOD HANDFUL</p>
          <h1>
            A little crunch.
            <br />
            <em>A little nazaakat.</em>
          </h1>
          <p className="hero-intro">
            For the everyday pause. The unexpected guest. The gift that says a little more. Discover
            dry fruits with a sense of occasion.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/shop">
                Explore the collection <ArrowUpRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/gifting">Discover gifting</Link>
            </Button>
          </div>
          <p className="text-muted-foreground mt-10 text-sm">
            Nuts &amp; Nazaakat · Premium dry fruits
          </p>
        </div>
        <div className="brand-hero-image">
          <img
            src="/assets/brand-hero.webp"
            alt="Nuts & Nazaakat cashew pouch with whole cashews on sculptural dark stone"
            width="1536"
            height="1024"
            fetchPriority="high"
          />
          <span className="image-caption">GOOD TASTE, BEAUTIFULLY PACKED.</span>
        </div>
      </section>
      <div className="ritual-strip">
        <span>EVERYDAY INDULGENCE</span>
        <span aria-hidden="true">✦</span>
        <span>THOUGHTFUL GIFTING</span>
        <span aria-hidden="true">✦</span>
        <span>INDIAN AT HEART</span>
      </div>
      <section className="container-page editorial-section">
        <div className="editorial-heading">
          <div>
            <p className="eyebrow">THE COLLECTION</p>
            <h2>Find your favourite handful.</h2>
          </div>
          <Link to="/shop" className="section-link">
            Shop all <ArrowUpRight className="inline size-4" />
          </Link>
        </div>
        <div className="category-editorial-grid">
          {categories.map((c) => (
            <Link
              key={c.slug}
              to="/category/$slug"
              params={{ slug: c.slug }}
              className="category-editorial"
            >
              <div className="overflow-hidden">
                <img src={c.image} alt={c.name} width="800" height="800" loading="lazy" />
              </div>
              <div className="flex items-start justify-between gap-3 pt-5">
                <div>
                  <h3>{c.name}</h3>
                  <p>{c.note}</p>
                </div>
                <ArrowUpRight className="mt-2 size-5" />
              </div>
            </Link>
          ))}
        </div>
      </section>
      <section className="container-page editorial-section pt-0">
        <div className="editorial-heading">
          <div>
            <p className="eyebrow">FROM OUR PANTRY</p>
            <h2>Make room for something good.</h2>
          </div>
          <Link to="/shop" className="section-link">
            Explore all
          </Link>
        </div>
        {featured.isLoading ? (
          <ProductGridSkeleton count={4} />
        ) : featured.isError ? (
          <div className="catalogue-notice" role="status">
            <p>Our collection couldn’t load. Please try again.</p>
            <Button variant="outline" onClick={() => void featured.refetch()}>
              Reload collection
            </Button>
          </div>
        ) : featured.data?.items.length ? (
          <div className="featured-grid">
            {featured.data.items.map((p) => (
              <ProductCard key={p.slug} product={p} />
            ))}
          </div>
        ) : (
          <div className="catalogue-notice">
            <p>Our next collection is being prepared.</p>
            <Link to="/contact" className="underline">
              Ask about availability
            </Link>
          </div>
        )}
      </section>
      <section className="gift-editorial">
        <div className="gift-image">
          <img
            src="/assets/brand-gifting.webp"
            alt="Nuts & Nazaakat gift assortment in a black presentation box"
            width="1536"
            height="1024"
            loading="lazy"
          />
        </div>
        <div className="gift-copy">
          <p className="eyebrow">FOR SOMEONE, WITH FEELING</p>
          <h2>
            Good things.
            <br />
            <em>Even better together.</em>
          </h2>
          <p>
            A thank you. A celebration. A just-because. Let a thoughtful assortment of nuts and dry
            fruits do the talking.
          </p>
          <Button asChild size="lg" variant="outline">
            <Link to="/gifting">
              Find your perfect gift <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        </div>
      </section>
      <section className="container-page editorial-section">
        <div className="brand-story">
          <p className="eyebrow">WHY NAZAAKAT?</p>
          <h2>
            Because the little things
            <br />
            <em>make all the difference.</em>
          </h2>
          <p>
            Nazaakat is a certain thoughtfulness. In what you serve, how you share it, and the way
            you make someone feel. That’s the spirit we bring to every handful.
          </p>
          <Link to="/about" className="section-link">
            Meet Nuts &amp; Nazaakat
          </Link>
        </div>
        <div className="service-grid">
          {[
            {
              icon: ShoppingBag,
              title: "Your everyday pantry",
              copy: "Choose a pack that fits your routine.",
            },
            {
              icon: Gift,
              title: "An occasion to remember",
              copy: "Explore gifts for celebrations, teams and clients.",
            },
            {
              icon: PackageCheck,
              title: "For your business",
              copy: "Explore grades, quantities and bulk pricing.",
            },
          ].map(({ icon: Icon, title, copy }) => (
            <div key={title}>
              <Icon className="mb-5 size-6" strokeWidth={1.3} />
              <h3>{title}</h3>
              <p>{copy}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="bulk-callout container-page">
        <div>
          <p className="eyebrow">FROM OUR PANTRY TO YOUR BUSINESS</p>
          <h2>Better together. Bigger by the kilo.</h2>
          <p>For cafés, kitchens, retailers and thoughtful corporate gifting.</p>
        </div>
        <Button asChild size="lg">
          <Link to="/bulk-orders">
            Explore bulk orders <ArrowUpRight className="size-4" />
          </Link>
        </Button>
      </section>
    </div>
  );
}
