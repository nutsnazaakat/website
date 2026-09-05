import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { inr } from "@/lib/format";

/** Sentinel for "no filter" — Radix Select forbids an empty-string item value. */
const ANY = "__any";

export interface ShopFilterValue {
  origin?: string;
  grade?: string;
  minPrice?: number;
  maxPrice?: number;
  bestsellerOnly?: boolean;
  inStockOnly?: boolean;
}

interface ShopFiltersProps {
  origins: string[];
  grades: string[];
  priceCeiling: number;
  value: ShopFilterValue;
  onChange: (patch: ShopFilterValue) => void;
  onReset: () => void;
}

export function ShopFilters({
  origins,
  grades,
  priceCeiling,
  value,
  onChange,
  onReset,
}: ShopFiltersProps) {
  const low = value.minPrice ?? 0;
  const high = value.maxPrice ?? priceCeiling;

  return (
    <div className="space-y-7">
      <div className="flex items-center justify-between">
        <p className="font-display text-xl">Filters</p>
        <Button variant="ghost" size="sm" onClick={onReset}>
          Reset
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="filter-origin">Origin</Label>
        <Select
          value={value.origin ?? ANY}
          onValueChange={(v) => onChange({ origin: v === ANY ? undefined : v })}
        >
          <SelectTrigger id="filter-origin">
            <SelectValue placeholder="Any origin" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any origin</SelectItem>
            {origins.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="filter-grade">Grade</Label>
        <Select
          value={value.grade ?? ANY}
          onValueChange={(v) => onChange({ grade: v === ANY ? undefined : v })}
        >
          <SelectTrigger id="filter-grade">
            <SelectValue placeholder="Any grade" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any grade</SelectItem>
            {grades.map((g) => (
              <SelectItem key={g} value={g}>
                {g}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-3">
        <Label>Price per kg</Label>
        <Slider
          min={0}
          max={priceCeiling}
          step={50}
          value={[low, high]}
          onValueChange={([a, b]) =>
            onChange({
              minPrice: a === 0 ? undefined : a,
              maxPrice: b === priceCeiling ? undefined : b,
            })
          }
        />
        <p className="text-muted-foreground text-xs">
          {inr(low)} – {inr(high)}
          {high === priceCeiling ? "+" : ""}
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="filter-bestseller"
            checked={value.bestsellerOnly ?? false}
            onCheckedChange={(c) => onChange({ bestsellerOnly: c === true ? true : undefined })}
          />
          <Label htmlFor="filter-bestseller" className="font-normal">
            Bestsellers only
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="filter-instock"
            checked={value.inStockOnly ?? false}
            onCheckedChange={(c) => onChange({ inStockOnly: c === true ? true : undefined })}
          />
          <Label htmlFor="filter-instock" className="font-normal">
            In stock only
          </Label>
        </div>
      </div>
    </div>
  );
}
