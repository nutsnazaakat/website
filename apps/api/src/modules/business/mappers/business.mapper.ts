import type { BusinessProfile } from '@nutwala/shared';
import type { Address } from '../../../entities/identity/address.entity';
import type { Business } from '../../../entities/identity/business.entity';
import { toSavedAddress } from '../../addresses/mappers/address.mapper';

/**
 * A business and its two resolved addresses, the shape `BusinessesService.getProfile` and
 * `.update` both hand back — never a bare `Business`, because a bare entity carries `segment`
 * and `assignedSalespersonId`, and this is where that boundary is drawn.
 */
export interface ResolvedBusiness {
  business: Business;
  billing: Address | null;
  shipping: Address | null;
}

/**
 * `Business` → `BusinessProfile`, for `GET`/`PUT /business/me`. The **only** place a `Business`
 * becomes this wire shape.
 *
 * **Built field by field, never a spread.** `Business` carries `segment` — a commercial decision
 * about this customer, admin-set — and `assignedSalespersonId` — internal sales routing. Neither
 * belongs on a customer-facing payload, and `segment` is the one worth being explicit about:
 * seeing `"segment": "retailer"` tells a business there are bands, that they are in one, and that
 * others exist, which invites "why am I not a distributor?" on a page that cannot answer it. The
 * **prices** a segment produces are correctly visible everywhere `PricingResolver` reaches; the
 * label that explains them is not, and this function is the wall.
 *
 * `mobile` passes through whatever the column holds, including `''` for a business that has
 * never filled in `/business/profile` — see `BusinessProfile`'s own docblock for why `GET` must
 * not invent a placeholder for it.
 */
export function toBusinessProfile(resolved: ResolvedBusiness): BusinessProfile {
  const { business, billing, shipping } = resolved;
  return {
    companyName: business.companyName,
    contactPerson: business.contactPerson,
    mobile: business.mobile,
    ...(business.gstin ? { gstin: business.gstin } : {}),
    businessType: business.businessType,
    billingAddress: billing ? toSavedAddress(billing) : null,
    shippingAddress: shipping ? toSavedAddress(shipping) : null,
  };
}
