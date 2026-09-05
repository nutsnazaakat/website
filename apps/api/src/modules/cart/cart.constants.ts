/**
 * The most of one line a basket may hold.
 *
 * Read by `CartLineDto`'s `@Max` and by `mergeLines`, which must honour the same bound because it
 * inserts into `cart_items` without passing through the DTO. One definition rather than the literal
 * `999` in two files, where one of them gets forgotten.
 *
 * 999 is where a customer should be using the RFQ form instead, which is also why the number is not
 * larger: a cart reserves no stock, so the cap is a usability boundary rather than a security one.
 */
export const MAX_LINE_QTY = 999;
