import type { Address } from '../../../entities/identity/address.entity';
import { toSavedAddress } from './address.mapper';

const row = (overrides: Partial<Address> = {}): Address =>
  ({
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    userId: 'f0000000-0000-4000-8000-00000000000a',
    label: 'Home',
    fullName: 'Asha Rao',
    phone: '9876543210',
    email: 'b2c@demo.in',
    line1: '12 Residency Road',
    line2: 'Near Mayo Hall',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560025',
    isDefault: true,
    deletedAt: null,
    createdAt: new Date('2025-11-04T09:12:00.000Z'),
    updatedAt: new Date('2025-11-04T09:12:00.000Z'),
    ...overrides,
  }) as unknown as Address;

describe('toSavedAddress', () => {
  it('answers exactly the wire contract, field for field', () => {
    expect(toSavedAddress(row())).toEqual({
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      label: 'Home',
      isDefault: true,
      fullName: 'Asha Rao',
      phone: '9876543210',
      email: 'b2c@demo.in',
      line1: '12 Residency Road',
      line2: 'Near Mayo Hall',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560025',
    });
  });

  /**
   * **The one assertion a spread would fail**, and it is a disclosure rather than an untidiness.
   *
   * `SavedAddress` has no `userId`, so nothing in the type system objects to sending one; the client
   * simply ignores a field it does not know about, and the account's primary key — the key spec §13
   * scopes every read by — ships in the body of five endpoints. `deletedAt` is the second: a row's
   * deletion history is not the customer's business and says how the table works.
   *
   * Written as an exact key list rather than three `not.toHaveProperty` calls, so a *fourth* internal
   * column added to the entity later is caught by the same case.
   */
  it('publishes no internal column — not the owner, not the tombstone, not the timestamps', () => {
    expect(Object.keys(toSavedAddress(row())).sort()).toEqual([
      'city',
      'email',
      'fullName',
      'id',
      'isDefault',
      'label',
      'line1',
      'line2',
      'phone',
      'pincode',
      'state',
    ]);
  });

  /**
   * `SavedAddress.line2` is `string | undefined`, and `null` is neither. `JSON.stringify` drops an
   * absent key, so omitting it is what makes the answer match the declared type; sending `line2: null`
   * would satisfy every test that only reads the other ten fields while handing the client a value its
   * own types say cannot occur.
   */
  it('omits line2 rather than sending null', () => {
    expect(toSavedAddress(row({ line2: null }))).not.toHaveProperty('line2');
  });

  /**
   * `''` cannot reach the column through this service — `AddressesService` normalises it — but the
   * column is `varchar(255)` and holds whatever the seeder, an import or a hand-run `UPDATE` put
   * there. An empty second line renders as nothing on the address card either way, so the wire says
   * nothing too.
   */
  it('omits an empty second line as well, whatever put it in the column', () => {
    expect(toSavedAddress(row({ line2: '' }))).not.toHaveProperty('line2');
  });
});
