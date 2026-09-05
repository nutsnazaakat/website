import type { SavedAddress } from '@nutwala/shared';
import type { Address } from '../../../entities/identity/address.entity';

/**
 * The **only** place an `Address` row becomes a wire `SavedAddress`.
 *
 * **Field by field, never a spread**, for the reason `order.mapper.ts`'s `toAddress` gives and one
 * more of its own. The row carries `userId`, `deletedAt`, `createdAt` and `updatedAt`; a spread would
 * put all four on the wire, and `userId` is the one that matters — `SavedAddress` has no such field,
 * so nothing would ever fail, and the response to every address read would quietly disclose the
 * account's primary key. Spec §13 scopes by that key; publishing it is the first half of handing it to
 * someone.
 *
 * `line2` is **omitted rather than sent**, and on truthiness rather than `!== null`. The column is
 * nullable and `AddressesService` normalises `''` to `null` on the way in, but `SavedAddress.line2` is
 * declared `string | undefined` and the address card renders `{address.line2 && …}` — so an empty
 * second line is already nothing on screen, and this keeps it nothing on the wire. `JSON.stringify`
 * drops an absent key, so the client sees no `line2` at all rather than `null`, which is what the
 * declared type promises.
 */
export function toSavedAddress(address: Address): SavedAddress {
  return {
    id: address.id,
    label: address.label,
    isDefault: address.isDefault,
    fullName: address.fullName,
    phone: address.phone,
    email: address.email,
    line1: address.line1,
    ...(address.line2 ? { line2: address.line2 } : {}),
    city: address.city,
    state: address.state,
    pincode: address.pincode,
  };
}
