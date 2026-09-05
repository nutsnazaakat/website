import { img } from "@/mocks/categories";

/**
 * The eight blog posts, as test data.
 *
 * **This was `src/mocks/posts.ts`, read by the production content API.** That is precisely the
 * defect Milestone 11 Task 2 fixed: `features/content/api` imported this array, so the admin
 * console's `/blog` screens wrote into `blog_posts` while the storefront rendered these eight
 * regardless. Moving the data here rather than deleting it keeps the route tests' assertions — eight
 * posts, the brief's four verbatim titles, one post under "Storage Tips" — while making its role
 * unambiguous: nothing in `src/` outside the test harness may read it.
 *
 * It mirrors `backend/src/database/seeds/content.seed.ts`, which seeds the same eight posts, so a
 * route test and an integration test are describing one catalogue.
 *
 * `readingMinutes` is absent: the server derives it from the body, and `content-api.stub.ts` does
 * the same, so an edit here can never leave a badge claiming the wrong length.
 *
 * Bodies deliberately stay descriptive. Nothing here asserts a certification, a test result or a
 * health outcome — brief §25 forbids unsupported claims, and a blog post is exactly where one tends
 * to slip in unnoticed.
 */
export interface PostFixture {
  slug: string;
  title: string;
  category: string;
  excerpt: string;
  image: string;
  author: string;
  publishedAt: string;
  body: string;
}

export const posts: PostFixture[] = [
  {
    slug: "how-to-choose-the-right-almonds",
    title: "How to Choose the Right Almonds",
    category: "Buying Guides",
    excerpt:
      "Californian, Mamra and Gurbandi almonds behave differently in the pan, in mithai and straight out of the pack. Here is how to pick the one your recipe actually wants.",
    image: img.almonds,
    author: "Nuts & Nazaakat",
    publishedAt: "2026-07-22T06:00:00.000Z",
    body: `Almonds are sold as though they were one product. They are not. The variety, the kernel size and how long the lot has been sitting all change what you get, and the differences are large enough that the wrong choice can flatten a recipe.

## Start with the variety, not the price

Three kinds turn up in most Indian kitchens.

- **Californian varieties** such as Independence and Nonpareil. Long, flat, pale kernels with an even shape. Mild flavour, reliable crunch, and the easiest to slice or sliver because the shape is so consistent.
- **Mamra**, grown in Iran and Afghanistan. Smaller, rounder, noticeably denser, and much sweeter. Costs several times more per kilo and is usually eaten as-is rather than cooked into anything.
- **Gurbandi**, also from Afghanistan. Small kernel, deep flavour, higher oil content. A middle path — more character than Californian, far less expensive than Mamra.

If a recipe asks for flaked or slivered almonds, a Californian variety is almost always the right answer. Uniform kernels cut cleanly. Mamra will fight the knife and cost you five times as much for the privilege.

## Then look at the kernel

Size grading is not a quality claim, only a size claim, but consistency within a pack is worth paying attention to. A pack where the kernels vary wildly usually means the lot was not sorted properly, and inconsistent kernels roast unevenly — some scorch while others are still raw.

Check for these before you commit to a large quantity:

1. Kernels of roughly the same length and thickness.
2. Skins intact, without large scraped patches.
3. No shrivelled or hollow-looking kernels, which have usually dried too hard.
4. A clean, sweet smell. Almonds are high in oil, and old oil announces itself.

> Buy a small pack of anything unfamiliar before you buy a kilo of it. Almonds keep well, but not well enough to make a bad kilo worth finishing.

## Match the almond to the job

**Daily snacking and soaking.** A Californian variety is fine and sensible. Soaking softens the skin so it slips off, which is the whole point for most people who soak.

**Mithai and halwa.** Gurbandi carries flavour through sugar and ghee better than a mild Californian kernel does.

**Baking.** Consistency beats character. Uniform Californian kernels slice, sliver and grind predictably, which matters more in a bake than a marginally richer flavour would.

**Gifting.** Mamra, if the budget allows. The difference is obvious enough that someone who eats almonds regularly will notice it immediately.

## A note on price per kilo

Pack sizes make comparison harder than it needs to be. Work out the price per kilogram before deciding anything — a 100g pack and a 1kg pack of the same almond can differ by a third once you normalise them. Every product page here shows the per-100g and per-kilogram rate alongside the pack price for exactly this reason.`,
  },
  {
    slug: "w320-vs-w240-cashews",
    title: "W320 vs W240 Cashews: What's the Difference?",
    category: "Dry Fruit Guides",
    excerpt:
      "The W number is a count, not a grade of quality. Understanding what it counts tells you which one to buy and roughly what it should cost.",
    image: img.cashews,
    author: "Nuts & Nazaakat",
    publishedAt: "2026-07-08T06:00:00.000Z",
    body: `Every bag of whole white cashews carries a code like W320 or W240. Buyers assume the smaller number means better quality. It means bigger, and bigger costs more — but bigger is not always what you want.

## What the number counts

**W** stands for *wholes*. The number is how many kernels it takes to make one pound. So:

- **W180** — around 180 kernels per pound. The largest commonly traded whole, sometimes called "king size".
- **W240** — around 240 per pound. Large, pale, and the usual choice when the cashew is meant to be seen.
- **W320** — around 320 per pound. The global default and by a wide margin the most traded grade.
- **W400** — around 400 per pound. Smaller kernels, still whole, and noticeably cheaper.

Fewer kernels per pound means each kernel is heavier, so W240 kernels are visibly larger than W320. That is the entire difference the grade describes. Colour, moisture and breakage are separate specifications that a grade code says nothing about.

## Which one to buy

**W240** earns its premium when the cashew is on display. Gift boxes, garnishes on a biryani, a bowl set out for guests, and roasted-and-salted packs where size reads as generosity.

**W320** is the sensible default for nearly everything else. Cooking, gravies, mithai, baking, everyday snacking. Once a kernel has been ground into a paste or fried into a curry base, nobody can tell you what its count per pound was.

**W400 and the broken grades** — pieces, splits, butts — are the right answer for anything blended. Cashew paste for a korma does not care about kernel geometry, and paying W240 money to grind it up is simply a donation.

> If the kernel is going to be blended, chopped or ground, buy the cheapest whole grade you trust — or buy pieces outright.

## What to check beyond the grade

Two lots of W320 from different suppliers can be quite different. Grade tells you size; these tell you condition.

1. **Colour.** White and even. Grey or yellowing kernels have usually been stored badly or too long.
2. **Breakage.** Some breakage in transit is normal. A pack that is a third splits was sold to you as wholes and is not.
3. **Moisture.** A kernel should snap, not bend. A soft cashew has absorbed moisture and will not crisp up properly when roasted.
4. **Smell.** Cashews are oily and go rancid quietly. Trust your nose over the packing date.

## Rough price expectations

Larger grades cost more per kilo, and the gap widens in a bad harvest year. As a rule of thumb, W240 sits meaningfully above W320, and W320 above W400 — but a supplier quoting W240 at a W320 price is not being generous. They are usually selling you W320.`,
  },
  {
    slug: "how-to-store-dry-fruits-at-home",
    title: "How to Store Dry Fruits at Home",
    category: "Storage Tips",
    excerpt:
      "Nuts do not usually spoil. They go soft, then they go stale, then the oil turns — and every stage is a storage problem you can prevent.",
    image: img.placeholder,
    author: "Nuts & Nazaakat",
    publishedAt: "2026-06-30T06:00:00.000Z",
    body: `Most dry fruit that gets thrown away at home was never spoiled in the food-safety sense. It went soft, or the oil turned, and it stopped being pleasant to eat. Both are storage problems, and both are avoidable.

## The three things that ruin nuts

**Air.** Nuts are mostly oil, and oil oxidises on contact with air. That is what "stale" tastes like — not decay, but oxidised fat. An open pouch rolled shut with a clip is losing to this every day.

**Moisture.** Crispness is a moisture-content property. A makhana pack left open in a Mumbai monsoon will be leathery within a day. Dried fruit has the opposite failure: it dries out further and hardens.

**Heat and light.** Both accelerate oxidation. The cabinet above the stove is the single worst place in most kitchens, and it is where most people keep the dry fruit.

## What to actually do

1. **Decant into airtight glass or steel.** Not the pouch with a clip. A jar with a proper seal, filled close to the top so there is little air left inside.
2. **Keep it dark and cool.** A low cupboard away from the stove beats a high one next to it. Direct sunlight on a glass jar undoes the point of the jar.
3. **Refrigerate what you will not finish in a month.** Cold slows oxidation considerably. Walnuts, pine nuts and anything already shelled benefit most, because they have the most exposed surface.
4. **Freeze the surplus.** Nuts freeze well for several months with no texture loss. Let a container come to room temperature *before* opening it, so condensation forms on the outside rather than on the nuts.
5. **Keep dried fruit separate from nuts.** Dates, anjeer and raisins hold more moisture and will pass it to anything crisp stored alongside them.

> One large jar opened daily ages faster than four small ones opened in turn. Divide a bulk purchase at the moment you open it, not when you get around to it.

## Reviving what has gone soft

Nuts that have gone soft but not rancid can usually be brought back. Spread them on a tray and warm them in a low oven — around 150°C — for eight to ten minutes, then cool completely before sealing. They crisp as they cool, not in the oven, so judging them while hot will lead you to overdo it.

This does not work on anything rancid. Rancidity is a chemical change in the oil and heat will not reverse it. If it smells like old paint or crayons, it is finished.

## Rough shelf expectations at home

- **In the pouch, opened:** two to three weeks before the crunch noticeably drops.
- **Airtight at room temperature:** two to three months.
- **Airtight and refrigerated:** six months or so.
- **Frozen:** most of a year.

Shelled nuts age faster than in-shell ones, roasted faster than raw, and salted or flavoured coatings faster still, because the coating draws moisture.`,
  },
  {
    slug: "how-businesses-can-buy-dry-fruits-in-bulk",
    title: "How Businesses Can Buy Dry Fruits in Bulk",
    category: "B2B",
    excerpt:
      "A practical guide to slab pricing, MOQs, sampling and specification-locking for sweet shops, bakeries, cafés and distributors buying by the kilo.",
    image: img.placeholder,
    author: "Nuts & Nazaakat",
    publishedAt: "2026-06-12T06:00:00.000Z",
    body: `Buying dry fruit for a business is a different exercise from buying it for a kitchen. Price per kilo matters, but consistency between consignments matters more — a bakery that changes almond variety mid-season has changed its product without meaning to.

## Understand slab pricing before you negotiate

Bulk dry fruit is almost always sold in quantity slabs rather than at a single rate. A typical structure runs 1–4 kg, 5–9 kg, 10–24 kg, 25–49 kg and 50 kg and above, with the rate stepping down at each boundary.

Two consequences follow, and both are worth acting on:

1. **Ordering just under a boundary is expensive.** If you need 23 kg and the next slab starts at 25 kg, the larger order is often cheaper in absolute terms, not merely per kilo. Check before you round down.
2. **The top slab is frequently unpriced.** At high volumes the rate depends on the harvest, the grade and the delivery schedule, which is why very large quantities go through a quotation rather than a published number.

## Lock the specification, not just the price

A price agreed against a vague product is not an agreement. Put these in writing on the first order so the second one can be compared to it:

- **Variety and grade** — W320, Independence, 5 Suta, and so on.
- **Origin** — kernels from different regions behave differently even at the same grade.
- **Moisture expectation** — the single biggest driver of shelf life once the pack is opened.
- **Breakage tolerance** — what percentage of splits you will accept in a "wholes" consignment.
- **Packing format** — 25 kg sacks, 5 kg vacuum packs, or retail-ready pouches.

## Always sample first

Order 1 kg of any grade you have not bought before, from any supplier you have not bought from before. Colour, crunch and yield are quick to judge and impossible to specify precisely on paper. A sample costs a few hundred rupees; a bad 50 kg consignment costs a great deal more, and usually arrives the week you needed it most.

> Sample the grade *and* the supplier. Two lots of the same specification from different sources are routinely different products in practice.

## Get the paperwork right

For a registered business the invoice matters as much as the goods.

- A **GST invoice with HSN codes** is what lets you claim input credit. Ask before ordering, not after.
- **Batch coding** on the outer packing makes a complaint traceable to a consignment instead of a guess.
- **Purchase order numbers** on the invoice save your accounts team a reconciliation exercise every month.

## Plan the calendar, not the order

Dry fruit prices move with harvest cycles and festival demand. Rates typically firm up in the weeks before Diwali, which is exactly when sweet shops and gift packers need the most. Placing a forward order — or at least agreeing a rate — before the season is the difference between a planned margin and an accidental one.

If your volumes are steady, ask about a locked rate across a period rather than negotiating each consignment. Most suppliers prefer predictable offtake enough to price it accordingly.`,
  },
  {
    slug: "makhana-chaat-in-ten-minutes",
    title: "Makhana Chaat in Ten Minutes",
    category: "Recipes",
    excerpt:
      "A roasted fox-nut chaat that comes together faster than ordering one, with the two mistakes that make it soggy.",
    image: img.placeholder,
    author: "Nuts & Nazaakat",
    publishedAt: "2026-08-04T06:00:00.000Z",
    body: `Makhana takes on flavour readily and goes soft just as readily. This chaat works because everything wet arrives at the last possible moment.

## What you need

- 100g makhana (roughly four generous cups)
- 1 tbsp ghee or a neutral oil
- 1 small onion, chopped fine
- 1 small tomato, deseeded and chopped fine
- 1 green chilli, chopped fine
- 2 tbsp chopped coriander
- 1 tsp chaat masala
- Juice of half a lime
- Salt to taste
- Optional: 2 tbsp roasted peanuts or a handful of fine sev

## Method

1. **Dry-roast the makhana first.** Warm a heavy pan on medium heat, add the ghee, then the makhana. Keep them moving for six to eight minutes until they are audibly crisp and just golden. This is the whole recipe — undercooked makhana turns chewy the moment anything wet touches it.
2. **Cool them completely.** Spread them on a plate and leave them for two minutes. They crisp as they cool. Skipping this is the second mistake.
3. **Deseed the tomato.** The seeds and pulp are the water that ruins the texture. Use the flesh only.
4. **Combine at the table.** Toss makhana, onion, tomato, chilli, coriander, chaat masala, salt and lime in a wide bowl, and serve immediately.

> Assemble it in front of whoever is eating it. Makhana chaat has a good five minutes in it and then it is a different, sadder dish.

## Variations worth trying

**Peri peri.** Skip the chaat masala and toss the hot makhana in peri peri seasoning straight out of the pan, then add the salad.

**Dahi makhana chaat.** Add two tablespoons of thick, well-drained curd and a spoon of tamarind chutney. Thin curd will collapse the texture within a minute, so drain it properly.

**Bhel-style.** Add fine sev and a tablespoon of chopped raw mango. The acidity does a lot of work here.

## Making it ahead

You can roast the makhana up to three days early. Cool completely, then store airtight — a jar, not a clipped pouch. Chop the vegetables no more than an hour ahead and keep them separate. The moment they meet is the moment the clock starts.`,
  },
  {
    slug: "how-much-dry-fruit-is-enough",
    title: "How Much Dry Fruit Is Actually Enough?",
    category: "Nutrition Education",
    excerpt:
      "Nuts are energy-dense by design, which is a feature until the handful becomes a bowl. A practical look at portioning without weighing anything.",
    image: img.placeholder,
    author: "Nuts & Nazaakat",
    publishedAt: "2026-07-15T06:00:00.000Z",
    body: `Dry fruit occupies an odd position: widely treated as something you cannot overdo, and simultaneously one of the more energy-dense foods in an average kitchen. Both things follow from the same fact — nuts are largely oil, and dried fruit is concentrated sugar.

*This is general information about portioning, not dietary advice. Anyone managing a specific condition should talk to a qualified professional rather than a blog post.*

## Why the handful is the unit

Nutritionists tend to talk in handfuls rather than grams because nobody weighs a snack. A closed handful of almonds is roughly 25 to 30 grams for most adults, which is a workable everyday portion and happens to scale with body size in about the right direction.

The problem is not the handful. It is that the handful is taken from an open jar in front of a screen, and the second handful does not register as a decision.

## Practical portioning that does not involve a scale

1. **Decant into a small bowl, then put the jar away.** The single most effective change, and the one people skip.
2. **Portion a week at a time.** Seven small containers on a Sunday removes the decision from the moment of hunger.
3. **Treat dried fruit as separate from nuts.** Dates, anjeer and raisins are sugar-dense in a way kernels are not. Mixing them in a trail blend makes it easy to eat considerably more sugar than intended.
4. **Notice the coating.** Roasted-and-salted, peri peri and honey-coated variants add salt or sugar to the base food, and the coating is usually what drives the second handful.

## Where soaking fits

Soaking almonds overnight softens the skin so it comes off easily, and many people find soaked almonds easier to eat and pleasanter in texture. Both of those are real and immediate. Claims beyond that vary widely in how well they are supported, so treat soaking as a preference rather than a requirement.

> If you enjoy them soaked, soak them. If you do not, the almond is still an almond.

## Reasonable expectations

Dry fruit is a useful, convenient, satisfying food that fits comfortably into most diets in modest quantities. It is not a supplement, and no single food does the work of an overall diet. The most sensible framing is the least dramatic one: a small daily portion, eaten deliberately, from a jar that is not sitting open on the desk.`,
  },
  {
    slug: "anjeer-dates-raisins-which-to-pick",
    title: "Anjeer, Dates and Raisins: Picking the Right Dried Fruit",
    category: "Dry Fruit Guides",
    excerpt:
      "Three dried fruits that get used interchangeably and should not be. What each one does in a recipe, and where each one falls apart.",
    image: img.placeholder,
    author: "Nuts & Nazaakat",
    publishedAt: "2026-05-28T06:00:00.000Z",
    body: `Anjeer, dates and raisins land in the same section of the shop and the same corner of most kitchens, and they are treated as substitutes far more often than they should be. They behave quite differently once heat or liquid is involved.

## Anjeer

Dried figs. Chewy, seedy, mildly sweet, with a texture that survives cooking better than either of the others.

**Where it works.** Anything simmered. Anjeer holds its shape in a milk-based sweet or a slow-cooked halwa where dates would dissolve into the background. Also the best of the three for stuffing, because the shape gives you something to work with.

**Where it fails.** Anywhere you want the sweetness to disperse. Anjeer stays a discrete object; it will not sweeten a batter.

**What to check.** Softness and colour. Anjeer hardens noticeably as it ages and the surface sugar bloom — a pale dusting — is normal rather than a fault.

## Dates

Two commonly sold types behave differently enough to be worth separating.

- **Medjool** — large, soft, almost caramel in texture. Expensive. Eaten as-is or used where its texture is the point.
- **Kimia** and similar everyday varieties — smaller, darker, softer still, and much cheaper. The sensible cooking date.

**Where it works.** Blending. Dates break down completely, which makes them the default sweetener in date-and-nut bars, smoothies and no-sugar sweets.

**Where it fails.** Anything that needs the fruit to stay identifiable through cooking, and anything where a slight molasses note would clash.

**What to check.** Stickiness is fine and expected. Crystallised sugar on the surface means it has dried out; fermented or wine-like smells mean it has gone too far the other way.

## Raisins

Grapes, dried. The most versatile and the least interesting on their own.

- **Golden or long golden** — plumper, milder, pale. Better where appearance matters.
- **Black or Afghani** — deeper, more acidic, more character.

**Where it works.** Pulao, sheera, baked goods, and anywhere small bursts of sweetness are wanted without changing the dish. Raisins rehydrate quickly in a hot liquid, which is exactly what you want in a pulao.

**Where it fails.** As a texture element. Raisins go soft under any sustained heat.

**What to check.** They should be pliable, not hard, and they should not clump into a single mass. Some natural stickiness is fine; a solid brick is not.

> If a recipe calls for one of the three and you are substituting, match the *behaviour* you need — holds shape, dissolves, or rehydrates — rather than matching the sweetness.

## A quick summary

- Need it to hold its shape through cooking: **anjeer**.
- Need it to disappear and sweeten: **dates**.
- Need small sweet bursts and fast rehydration: **raisins**.`,
  },
  {
    slug: "soaked-vs-raw-almonds",
    title: "Soaked vs Raw Almonds: What Actually Changes",
    category: "Nutrition Education",
    excerpt:
      "Soaking changes the skin, the texture and the taste. Here is what is easy to observe, and where the confident claims outrun the evidence.",
    image: img.almonds,
    author: "Nuts & Nazaakat",
    publishedAt: "2026-05-06T06:00:00.000Z",
    body: `Soaking almonds overnight is close to universal in Indian households, and the reasons given for it range from the obvious to the wildly overstated. It is worth separating the two.

*General information, not dietary advice.*

## What you can see for yourself

**The skin loosens.** This is the clearest effect and the easiest to verify. After six to eight hours in water the brown skin slips off with light pressure. For anyone who finds the skin bitter or hard to chew, that alone settles the question.

**The texture changes.** A soaked almond is softer and slightly springy rather than hard and snapping. Some people much prefer this; some find it unpleasant. Neither is wrong.

**The flavour mellows.** Removing the skin removes most of the tannic bitterness, leaving something sweeter and plainer.

## What is harder to be confident about

Beyond skin, texture and taste, the claims get considerably less settled. Digestibility and nutrient availability come up constantly, and the honest position is that the effects are debated, the studies are mixed, and the sizes involved are generally small. Anyone stating a firm number is going further than the evidence comfortably supports.

> The safe conclusion: soak because you prefer them soaked. Treat everything beyond that as unsettled.

## How to soak properly

1. Cover the almonds generously with room-temperature water — they swell.
2. Leave six to eight hours, or overnight. Longer than twelve hours in warm weather risks fermentation and a sour smell.
3. In hot months, soak in the fridge.
4. Drain, rinse, and peel if you want to.
5. Eat within a day or two, refrigerated. A soaked almond is a wet food and no longer has the shelf life of a dry one.

## When not to soak

Soaked almonds are wrong for most cooking. They will not roast, they will not slice cleanly, they will not grind to a dry powder, and they carry water into anything they are added to. Keep a dry supply for the kitchen and soak only what you plan to eat.

## The practical takeaway

Soaking is a preference with a couple of clearly observable effects and a lot of confident folklore attached. Both soaked and raw almonds are ordinary, useful foods. Choose the one you will actually eat.`,
  },
];
