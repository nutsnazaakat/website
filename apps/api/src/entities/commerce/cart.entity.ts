import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { User } from '../identity/user.entity';
import type { CartItem } from './cart-item.entity';

/**
 * Persisted for signed-in users and for guests alike, per spec §5.3: a signed-in cart is keyed by
 * `userId`, an anonymous one by `guestToken`, and exactly one of the two is set. A guest who signs
 * in has their basket merged into their own cart rather than losing it. Server persistence also
 * gives brief §38's abandoned-cart notification something to read, and lets a cart survive a
 * device change.
 */
@Entity('carts')
export class Cart extends BaseEntity {
  @Index('uq_carts_user', { unique: true })
  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId: string | null;

  /**
   * Opaque key for an anonymous cart, held in the `nn_guest_token` cookie. Exactly one of this
   * and `userId` is set — `ck_carts_owner_exclusive` enforces it in the database rather than trusting
   * every future writer to remember.
   */
  @Column({ type: 'varchar', length: 64, name: 'guest_token', nullable: true })
  guestToken: string | null;

  @OneToMany('CartItem', 'cart', { cascade: true })
  items: CartItem[];
}
