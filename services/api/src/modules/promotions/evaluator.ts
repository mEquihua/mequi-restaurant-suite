import type { DatabaseTransaction } from '../../shared/index.js';

export async function evaluateBestPromotion(
  trx: DatabaseTransaction,
  input: {
    organizationId: string;
    productId: string;
    categoryId: string | null;
    lineAmount: number;
    now: Date;
  }
): Promise<{ promotion_id: string; computed_amount: number } | null> {
  const dayOfWeek = input.now.getDay() === 0 ? 7 : input.now.getDay(); // ISO 1-7
  const timeString = input.now.toTimeString().split(' ')[0]; // HH:MM:SS

  // query all active promotions matching the org
  const promotions = await trx
    .selectFrom('promotions')
    .selectAll()
    .where('organization_id', '=', input.organizationId)
    .where('is_active', '=', true)
    .execute();

  let bestPromotion: { promotion_id: string; computed_amount: number } | null = null;
  let maxDiscount = 0;

  for (const promo of promotions) {
    // Check product/category match
    const matchesProduct = promo.product_id === input.productId;
    const matchesCategory = promo.category_id && input.categoryId && promo.category_id === input.categoryId;
    const isGlobal = !promo.product_id && !promo.category_id;

    if (!matchesProduct && !matchesCategory && !isGlobal) {
      continue;
    }

    // Check dates
    if (promo.starts_at && new Date(promo.starts_at) > input.now) continue;
    if (promo.ends_at && new Date(promo.ends_at) < input.now) continue;

    // Check days of week
    if (promo.days_of_week && promo.days_of_week.length > 0) {
      if (!promo.days_of_week.includes(dayOfWeek)) continue;
    }

    // Check time
    if (promo.start_time && timeString < promo.start_time) continue;
    if (promo.end_time && timeString > promo.end_time) continue;

    let discountAmount = 0;
    if (promo.discount_type === 'PERCENTAGE') {
      discountAmount = Math.floor(input.lineAmount * (promo.discount_value / 100));
    } else if (promo.discount_type === 'AMOUNT') {
      discountAmount = promo.discount_value;
    }

    // Cap discount at line amount
    discountAmount = Math.min(discountAmount, input.lineAmount);

    if (discountAmount > maxDiscount) {
      maxDiscount = discountAmount;
      bestPromotion = { promotion_id: promo.id, computed_amount: discountAmount };
    }
  }

  return bestPromotion;
}
