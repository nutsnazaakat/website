import heroImg from "@/assets/hero-dryfruits.jpg";
import almondsImg from "@/assets/cat-almonds.jpg";
import cashewsImg from "@/assets/cat-cashews.jpg";
import pistachiosImg from "@/assets/cat-pistachios.jpg";
import type { Category } from "@/features/catalog/types";

export const img = {
  almonds: almondsImg,
  cashews: cashewsImg,
  pistachios: pistachiosImg,
  mixed: heroImg,
  placeholder: "https://placehold.co/800x800",
};

export const categories: Category[] = [
  { slug: "almonds", name: "Almonds", image: img.almonds, blurb: "Badam, graded and crisp", description: "Graded almond kernels from California, Iran and Afghanistan." },
  { slug: "cashews", name: "Cashews", image: img.cashews, blurb: "W240 & W320 kaju", description: "Whole white cashew kernels in standard export grades." },
  { slug: "pistachios", name: "Pistachios", image: img.pistachios, blurb: "Roasted & salted pista", description: "In-shell and kernel pistachios for snacking and mithai." },
  { slug: "walnuts", name: "Walnuts", image: img.mixed, blurb: "Light halves, akhrot", description: "Light-coloured walnut halves and pieces." },
  { slug: "raisins", name: "Raisins", image: img.mixed, blurb: "Golden & black kishmish", description: "Seedless raisins in golden and black varieties." },
  { slug: "dates", name: "Dates", image: img.mixed, blurb: "Medjool, Kimia khajoor", description: "Soft dates from Jordan, the UAE and Iran." },
  { slug: "anjeer", name: "Anjeer", image: img.mixed, blurb: "Soft dried figs", description: "Hand-sorted dried figs." },
  { slug: "makhana", name: "Makhana", image: img.mixed, blurb: "Roasted fox nuts", description: "Roasted and flavoured fox nuts from Bihar." },
  { slug: "seeds", name: "Seeds", image: img.mixed, blurb: "Pumpkin, sunflower", description: "Shelled seeds for daily mixing and baking." },
  { slug: "trail-mixes", name: "Trail Mixes", image: img.mixed, blurb: "Everyday snacking", description: "House blends of nuts, seeds and berries." },
  { slug: "roasted-nuts", name: "Roasted Nuts", image: img.mixed, blurb: "Lightly roasted", description: "Lightly roasted and salted nuts." },
  { slug: "combos", name: "Combos", image: img.mixed, blurb: "Boxes & value packs", description: "Value packs and gift boxes." },
];
