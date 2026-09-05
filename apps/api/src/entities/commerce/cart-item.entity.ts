import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { OrderChannelEnum } from '../enums';
import { Product } from '../catalog/product.entity';
import { ProductVariant } from '../catalog/product-variant.entity';
import { Cart } from './cart.entity';

/**
 * Mirrors the frontend's `CartLine`.
 *
 * Deliberately has no price column. A cart is a list of intentions; the price is resolved
 * live on every read, so a catalogue price change is reflected immediately rather than a
 * stale figure being carried to checkout. Spec §13 forbids trusting a client-supplied price
 * for the same reason.
 */
@Entity('cart_items')
export class CartItem extends BaseEntity {
  @Index('idx_cart_items_cart')
  @ManyToOne(() => Cart, (cart) => cart.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cart_id' })
  cart: Cart;

  @Column({ type: 'uuid', name: 'cart_id' })
  cartId: string;

  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'uuid', name: 'product_id' })
  productId: string;

  /** Set on a retail line. Null on a bulk line, which is priced per kg from a tier. */
  @ManyToOne(() => ProductVariant, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'variant_id' })
  variant: ProductVariant | null;

  @Column({ type: 'uuid', nullable: true, name: 'variant_id' })
  variantId: string | null;

  @Column({ type: 'enum', enum: OrderChannelEnum })
  mode: OrderChannelEnum;

  /** Bulk lines carry a kilogram quantity instead of a variant. */
  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  kg: string | null;

  @Column({ type: 'int', default: 1 })
  qty: number;
}
