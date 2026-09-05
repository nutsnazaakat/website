import type { DataSource, EntityManager } from 'typeorm';
import { BlogPost } from '../../entities/content/blog-post.entity';
import { Review } from '../../entities/content/review.entity';
import { ReviewStatus } from '../../entities/enums';
import { BLOG_POSTS } from './blog-posts.data';
import { IMAGES, loadProductIdsBySlug, requireValue } from './seed-context';

/**
 * Blog posts and reviews, ported from `frontend/src/mocks/posts.ts` and
 * `frontend/src/mocks/reviews.ts`.
 */

interface ReviewSeed {
  productSlug: string;
  author: string;
  rating: number;
  body: string;
  imageUrl: string | null;
  verifiedPurchase: boolean;
  status: ReviewStatus;
  createdAt: string;
}

/**
 * All 14 reviews from `frontend/src/mocks/reviews.ts`.
 *
 * Each row keeps the mock's own `status`. Every one of the 14 is `approved` in the mock, and
 * that is preserved rather than diversified: inventing a PENDING or REJECTED row to give the
 * brief §27 moderation queue something to show would be fabricated content, and the queue's
 * real first occupant is whatever a visitor submits. Consequence worth stating plainly — the
 * moderation queue seeds **empty**, exactly as the mock's own comment says it should.
 *
 * `verifiedPurchase` is likewise the mock's value. The entity notes that in production only the
 * server may set it, after finding a DELIVERED order for that user containing that product;
 * these rows carry no `userId`, so the flag here is fixture data rather than a derived claim.
 *
 * The mock's `rev-NNNN` ids have no column to land in — the primary key is a UUID — so
 * `(productId, author)` is the natural key used for the re-run. All 14 authors are distinct.
 */
const REVIEW_SEEDS: ReviewSeed[] = [
  {
    productSlug: 'w320-cashews',
    author: 'Meera S.',
    rating: 5,
    body: 'Ordered the 1kg pack for Diwali mithai. Kernels are whole, uniform and none of the dust you get from loose kaju at the local shop. Will reorder.',
    imageUrl: IMAGES.placeholder,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-07-28T10:12:00.000Z',
  },
  {
    productSlug: 'w320-cashews',
    author: 'Anil Kumar',
    rating: 4,
    body: 'Good grade and packed well. Took four days to reach Guwahati, which is a bit slow, but the pack was sealed and intact.',
    imageUrl: null,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-07-14T06:40:00.000Z',
  },
  {
    productSlug: 'w320-cashews',
    author: 'Farida N.',
    rating: 5,
    body: 'We run a small bakery and switched to these for our cashew cookies. Consistent size means consistent bake time, which matters more than I expected.',
    imageUrl: null,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-06-30T12:05:00.000Z',
  },
  {
    productSlug: 'w320-cashews',
    author: 'Rohit D.',
    rating: 3,
    body: 'Taste is fine but I found a few broken pieces near the bottom of the pouch. Support replaced it without argument, so three stars rather than two.',
    imageUrl: null,
    verifiedPurchase: false,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-06-11T15:22:00.000Z',
  },
  {
    productSlug: 'w320-cashews',
    author: 'Sneha Patil',
    rating: 5,
    body: 'The per-kg price on the 5kg option works out much cheaper than my usual wholesaler and the invoice had proper HSN codes for my accountant.',
    imageUrl: null,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-05-19T08:00:00.000Z',
  },
  {
    productSlug: 'premium-california-almonds',
    author: 'Vikram Iyer',
    rating: 5,
    body: 'Crunchy right out of the pouch and still crunchy three weeks later in an airtight jar. The 500g pack is the right size for two people.',
    imageUrl: IMAGES.placeholder,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-08-02T04:30:00.000Z',
  },
  {
    productSlug: 'premium-california-almonds',
    author: 'Kavya R.',
    rating: 4,
    body: 'Kernels are uniform and clean. I soak these overnight and the skins come off easily, which is my main test.',
    imageUrl: null,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-07-21T09:15:00.000Z',
  },
  {
    productSlug: 'premium-california-almonds',
    author: 'Deepak M.',
    rating: 2,
    body: 'The badam themselves are decent but my first pack arrived with a torn corner. Replacement was quick, however I would like sturdier outer packing.',
    imageUrl: null,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-06-05T11:45:00.000Z',
  },
  {
    productSlug: 'mamra-almonds',
    author: 'Zoya A.',
    rating: 5,
    body: 'Genuinely different from regular almonds — denser and much sweeter. Expensive, but I buy 250g at a time and it lasts.',
    imageUrl: null,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-07-09T13:20:00.000Z',
  },
  {
    productSlug: 'premium-pistachios',
    author: 'Harish B.',
    rating: 4,
    body: 'Well roasted and not over-salted, which is rare. Shells open easily so you are not fighting the pack.',
    imageUrl: null,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-07-02T17:05:00.000Z',
  },
  {
    productSlug: 'roasted-makhana',
    author: 'Ishita G.',
    rating: 5,
    body: 'Light, crisp and no stale aftertaste. My kids finish a 100g pack in a sitting, which is either praise or a warning.',
    imageUrl: null,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-08-06T07:55:00.000Z',
  },
  {
    productSlug: 'medjool-dates',
    author: 'Sameer Q.',
    rating: 5,
    body: 'Soft, caramel-like and clearly fresh. Arrived cool despite the weather here in Nagpur.',
    imageUrl: IMAGES.placeholder,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-07-17T05:10:00.000Z',
  },
  {
    productSlug: 'afghani-black-raisins',
    author: 'Nandini P.',
    rating: 4,
    body: 'Properly seedless and not sticky. Good value at the 1kg size for a family that bakes a lot.',
    imageUrl: null,
    verifiedPurchase: false,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-06-24T14:35:00.000Z',
  },
  {
    productSlug: 'daily-dry-fruit-combo',
    author: 'Tarun S.',
    rating: 4,
    body: 'Sensible mix and the box is sturdy enough to gift as-is. Would prefer a little more cashew and a little less raisin.',
    imageUrl: null,
    verifiedPurchase: true,
    status: ReviewStatus.APPROVED,
    createdAt: '2026-07-30T10:00:00.000Z',
  },
];

async function seedBlogPosts(manager: EntityManager): Promise<number> {
  await manager.getRepository(BlogPost).upsert(
    BLOG_POSTS.map((post) => ({
      slug: post.slug,
      title: post.title,
      category: post.category,
      excerpt: post.excerpt,
      image: post.image,
      author: post.author,
      body: post.body,
      isPublished: true,
      publishedAt: new Date(post.publishedAt),
      // The mock carries no per-post SEO block, and a generated one would be invented copy.
      seo: {},
    })),
    ['slug'],
  );

  return BLOG_POSTS.length;
}

async function seedReviews(
  manager: EntityManager,
  productIdBySlug: ReadonlyMap<string, string>,
): Promise<number> {
  const reviews = manager.getRepository(Review);

  for (const seed of REVIEW_SEEDS) {
    const productId = requireValue(
      productIdBySlug.get(seed.productSlug),
      `product "${seed.productSlug}" for the review by ${seed.author}`,
    );

    const columns = {
      productId,
      productSlug: seed.productSlug,
      // The mock's authors are display names, not the fixture accounts, so there is nobody to
      // attribute these to. A guessed `userId` would make `verifiedPurchase` a false claim.
      userId: null,
      author: seed.author,
      rating: seed.rating,
      body: seed.body,
      imageUrl: seed.imageUrl,
      verifiedPurchase: seed.verifiedPurchase,
      status: seed.status,
      moderatedByUserId: null,
      moderatedAt: null,
      rejectionReason: null,
    };

    const existing = await reviews.findOne({
      where: { productId, author: seed.author },
      select: { id: true },
    });
    if (existing) {
      await reviews.update(existing.id, columns);
    } else {
      await reviews.insert({ ...columns, createdAt: new Date(seed.createdAt) });
    }
  }

  return REVIEW_SEEDS.length;
}

/**
 * Rebuilds `Product.ratingAvg` and `Product.reviewCount` from the `reviews` table.
 *
 * APPROVED rows only, which is the same population the public product page shows, so the
 * denormalised pair agrees with the visible list from the first row onwards. Done in SQL over
 * every product — including the 19 with no reviews, which must read 0 rather than keep a
 * stale figure — because a per-product round trip would be 27 statements to say one thing.
 */
async function recomputeReviewAggregates(manager: EntityManager): Promise<void> {
  await manager.query(`
    UPDATE "products" AS p
    SET "ratingAvg" = aggregate."ratingAvg",
        "reviewCount" = aggregate."reviewCount"
    FROM (
      SELECT p2."id" AS "productId",
             COALESCE(ROUND(AVG(r."rating")::numeric, 2), 0) AS "ratingAvg",
             COUNT(r."id") AS "reviewCount"
      FROM "products" p2
      LEFT JOIN "reviews" r ON r."product_id" = p2."id" AND r."status" = 'APPROVED'
      GROUP BY p2."id"
    ) AS aggregate
    WHERE p."id" = aggregate."productId"
      AND (p."ratingAvg" <> aggregate."ratingAvg" OR p."reviewCount" <> aggregate."reviewCount")
  `);
}

export async function seedContent(dataSource: DataSource): Promise<number> {
  const productIdBySlug = await loadProductIdsBySlug(dataSource);
  if (productIdBySlug.size === 0) {
    throw new Error('No products found. Run the catalog seeder before the content seeder.');
  }

  return dataSource.transaction(async (manager) => {
    let rows = await seedBlogPosts(manager);
    rows += await seedReviews(manager, productIdBySlug);
    await recomputeReviewAggregates(manager);
    return rows;
  });
}
