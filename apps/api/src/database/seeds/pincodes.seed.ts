import { toPaise } from '@nutwala/shared';
import type { DataSource } from 'typeorm';
import { ServiceablePincode } from '../../entities/commerce/serviceable-pincode.entity';

/**
 * One rule per leading digit, which is the coarsest useful shape for a longest-prefix table.
 *
 * Phase 1 answered the pincode checker with `/^[2-8]\d{5}$/`. That is reproduced here closely
 * enough for the existing checker UI to keep behaving, while being admin-editable as spec §5.3
 * requires: `0` and `9` are the two prefixes India does not issue civilian pincodes under, so
 * they are the honest non-serviceable rows.
 */
const SERVICEABLE_PREFIXES = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;
const UNSERVICEABLE_PREFIXES = ['0', '9'] as const;

const ETA_DAYS = 4;

export async function seedPincodes(dataSource: DataSource): Promise<number> {
  const repository = dataSource.getRepository(ServiceablePincode);

  const rows = [
    ...SERVICEABLE_PREFIXES.map((pincodePrefix) => ({
      pincodePrefix,
      isServiceable: true,
      etaDays: ETA_DAYS,
      shippingPaise: toPaise(79),
    })),
    ...UNSERVICEABLE_PREFIXES.map((pincodePrefix) => ({
      pincodePrefix,
      isServiceable: false,
      etaDays: ETA_DAYS,
      shippingPaise: toPaise(0),
    })),
  ];

  for (const row of rows) {
    await repository.upsert(row, ['pincodePrefix']);
  }

  return rows.length;
}
