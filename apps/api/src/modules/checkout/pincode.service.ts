import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ServiceablePincode } from '../../entities/commerce/serviceable-pincode.entity';

export interface PincodeVerdict {
  isServiceable: boolean;
  etaDays: number;
  shippingPaise: bigint;
  /** The row that answered, or null when nothing matched. Returned so a caller can log *why*. */
  matchedPrefix: string | null;
}

/**
 * Unserviceable, and cheap to state: an unknown pincode is a refusal rather than a default delivery.
 * The alternative promises a delivery nobody has planned, and the customer learns of it after paying.
 *
 * The ETA and the charge are zero rather than the seeded four days and ₹79, so a caller that reads
 * them without checking `isServiceable` shows an obviously broken figure instead of a plausible one.
 */
const NO_MATCH: PincodeVerdict = {
  isServiceable: false,
  etaDays: 0,
  shippingPaise: 0n,
  matchedPrefix: null,
};

@Injectable()
export class PincodeService {
  constructor(
    @InjectRepository(ServiceablePincode) private readonly pincodes: Repository<ServiceablePincode>,
  ) {}

  /**
   * The single source of both the ETA and the per-destination shipping charge.
   *
   * Four things currently claim to be the ETA — `checkPincode`'s digit-sum, `placeOrder`'s hardcoded
   * `+4 days`, this column, and a fourth `addDays(new Date(), 4)` rendered in the Shipping card — and
   * four claim to be the shipping charge. This row is the only one that is per-destination and
   * admin-editable, which is why it wins. Unifying the remaining copies is Milestone 8's.
   *
   * One `IN` over every candidate prefix rather than six queries or a `LIKE`. A six-digit pincode has
   * exactly six possible prefixes, so one primary-key lookup fetches all the rows that could match
   * and the longest is picked in memory.
   *
   * `Like(`${pincode}%`)` is the tempting alternative and it is wrong in the *opposite* direction to
   * the obvious guess: it asks for rows that start with the whole pincode, so against a `varchar(6)`
   * key it can only ever return the exact row and silently misses every region row above it — `110`
   * and `1` would never be seen. The comparison that would be correct is the other way round
   * (`:pincode LIKE pincode_prefix || '%'`), which is not a column predicate, cannot use the primary
   * key, and reads worse than the six values it is avoiding.
   */
  async resolve(pincode: string): Promise<PincodeVerdict> {
    const candidates = Array.from({ length: pincode.length }, (_, i) => pincode.slice(0, i + 1));
    const rows = await this.pincodes.find({ where: { pincodePrefix: In(candidates) } });
    if (rows.length === 0) return NO_MATCH;

    const best = rows.reduce((longest, row) =>
      row.pincodePrefix.length > longest.pincodePrefix.length ? row : longest,
    );

    return {
      isServiceable: best.isServiceable,
      etaDays: best.etaDays,
      shippingPaise: best.shippingPaise,
      matchedPrefix: best.pincodePrefix,
    };
  }
}
