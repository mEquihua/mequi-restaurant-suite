import { sql } from 'kysely';

import type { DatabaseTransaction } from '../../../shared/index.js';

export interface ReportRange {
  locationId: string;
  from: Date;
  to: Date;
}

type ReportRow = Record<string, unknown>;
const numbers = (rows: ReportRow[]) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) =>
        typeof value === 'string' && /^(?:-?\d+(?:\.\d+)?)$/.test(value)
          ? [key, Number(value)]
          : [key, value],
      ),
    ),
  );
const run = async (trx: DatabaseTransaction, query: ReturnType<typeof sql>) =>
  numbers((await query.execute(trx)).rows as ReportRow[]);

export const salesByDay = (trx: DatabaseTransaction, range: ReportRange) =>
  run(
    trx,
    sql`
      WITH settlements AS (
        SELECT p.account_id, min(p.created_at) AS settled_at
        FROM payments p
        WHERE p.location_id = ${range.locationId} AND p.status = 'COMPLETED'
        GROUP BY p.account_id
      ), sales AS (
        SELECT DATE(s.settled_at AT TIME ZONE l.timezone) AS bucket,
          sum(a.subtotal + a.tax)::bigint AS gross_sales,
          sum(a.discount)::bigint AS discounts
        FROM settlements s
        JOIN accounts a ON a.id = s.account_id
        JOIN locations l ON l.id = a.location_id
        WHERE a.location_id = ${range.locationId}
          AND s.settled_at >= ${range.from} AND s.settled_at < ${range.to}
        GROUP BY DATE(s.settled_at AT TIME ZONE l.timezone)
      ), refunded AS (
        SELECT DATE(r.created_at AT TIME ZONE l.timezone) AS bucket,
          sum(r.amount)::bigint AS refunds
        FROM refunds r
        JOIN locations l ON l.id = r.location_id
        WHERE r.location_id = ${range.locationId}
          AND r.created_at >= ${range.from} AND r.created_at < ${range.to}
        GROUP BY DATE(r.created_at AT TIME ZONE l.timezone)
      )
      SELECT to_char(coalesce(s.bucket, r.bucket), 'YYYY-MM-DD') AS day,
        coalesce(s.gross_sales, 0)::bigint AS gross_sales,
        coalesce(s.discounts, 0)::bigint AS discounts,
        coalesce(r.refunds, 0)::bigint AS refunds,
        (coalesce(s.gross_sales, 0) - coalesce(s.discounts, 0) - coalesce(r.refunds, 0))::bigint AS net_sales
      FROM sales s FULL OUTER JOIN refunded r ON r.bucket = s.bucket
      ORDER BY coalesce(s.bucket, r.bucket)
    `,
  );

export const salesByHour = (trx: DatabaseTransaction, range: ReportRange) =>
  run(
    trx,
    sql`
      WITH settlements AS (
        SELECT p.account_id, min(p.created_at) AS settled_at
        FROM payments p
        WHERE p.location_id = ${range.locationId} AND p.status = 'COMPLETED'
        GROUP BY p.account_id
      ), sales AS (
        SELECT extract(hour FROM s.settled_at AT TIME ZONE l.timezone)::integer AS hour,
          sum(a.subtotal + a.tax)::bigint AS gross_sales,
          sum(a.discount)::bigint AS discounts
        FROM settlements s JOIN accounts a ON a.id = s.account_id JOIN locations l ON l.id = a.location_id
        WHERE a.location_id = ${range.locationId} AND s.settled_at >= ${range.from} AND s.settled_at < ${range.to}
        GROUP BY extract(hour FROM s.settled_at AT TIME ZONE l.timezone)
      ), refunded AS (
        SELECT extract(hour FROM r.created_at AT TIME ZONE l.timezone)::integer AS hour, sum(r.amount)::bigint AS refunds
        FROM refunds r JOIN locations l ON l.id = r.location_id
        WHERE r.location_id = ${range.locationId} AND r.created_at >= ${range.from} AND r.created_at < ${range.to}
        GROUP BY extract(hour FROM r.created_at AT TIME ZONE l.timezone)
      )
      SELECT coalesce(s.hour, r.hour)::integer AS hour, coalesce(s.gross_sales, 0)::bigint AS gross_sales,
        coalesce(s.discounts, 0)::bigint AS discounts, coalesce(r.refunds, 0)::bigint AS refunds,
        (coalesce(s.gross_sales, 0) - coalesce(s.discounts, 0) - coalesce(r.refunds, 0))::bigint AS net_sales
      FROM sales s FULL OUTER JOIN refunded r ON r.hour = s.hour
      ORDER BY coalesce(s.hour, r.hour)
    `,
  );

export const salesByProduct = (trx: DatabaseTransaction, range: ReportRange, limit: number, offset: number) =>
  run(trx, sql`
    SELECT p.id AS product_id, p.name AS product_name, sum(ol.quantity)::bigint AS quantity_sold,
      sum(ol.quantity * ol.unit_price)::bigint AS gross_sales
    FROM order_lines ol JOIN products p ON p.id = ol.product_id JOIN orders o ON o.id = ol.order_id
    WHERE ol.location_id = ${range.locationId} AND o.created_at >= ${range.from} AND o.created_at < ${range.to}
      AND ol.status NOT IN ('VOIDED', 'CANCELLED', 'REJECTED')
    GROUP BY p.id, p.name ORDER BY gross_sales DESC, p.name LIMIT ${limit} OFFSET ${offset}
  `);

export const salesByCategory = (trx: DatabaseTransaction, range: ReportRange) =>
  run(trx, sql`
    SELECT c.id AS category_id, c.name AS category_name, sum(ol.quantity)::bigint AS quantity_sold,
      sum(ol.quantity * ol.unit_price)::bigint AS gross_sales
    FROM order_lines ol JOIN products p ON p.id = ol.product_id JOIN categories c ON c.id = p.category_id JOIN orders o ON o.id = ol.order_id
    WHERE ol.location_id = ${range.locationId} AND o.created_at >= ${range.from} AND o.created_at < ${range.to}
      AND ol.status NOT IN ('VOIDED', 'CANCELLED', 'REJECTED')
    GROUP BY c.id, c.name ORDER BY gross_sales DESC, c.name
  `);

export const salesByEmployee = (trx: DatabaseTransaction, range: ReportRange) =>
  run(trx, sql`
    WITH payment_totals AS (
      SELECT p.account_id, sum(p.tip_amount)::bigint AS total_tips
      FROM payments p WHERE p.location_id = ${range.locationId} AND p.status = 'COMPLETED' GROUP BY p.account_id
    ), refund_totals AS (
      SELECT r.payment_id, sum(r.amount)::bigint AS amount FROM refunds r
      WHERE r.location_id = ${range.locationId} GROUP BY r.payment_id
    ), account_refunds AS (
      SELECT p.account_id, sum(coalesce(r.amount, 0))::bigint AS refunds FROM payments p
      LEFT JOIN refund_totals r ON r.payment_id = p.id WHERE p.location_id = ${range.locationId} GROUP BY p.account_id
    )
    SELECT v.staff_id, s.first_name, s.last_name, sum(a.subtotal + a.tax)::bigint AS gross_sales,
      sum(a.discount)::bigint AS discounts, sum(coalesce(ar.refunds, 0))::bigint AS refunds,
      (sum(a.subtotal + a.tax) - sum(a.discount) - sum(coalesce(ar.refunds, 0)))::bigint AS net_sales,
      sum(coalesce(pt.total_tips, 0))::bigint AS total_tips
    FROM visits v JOIN staff s ON s.id = v.staff_id JOIN accounts a ON a.visit_id = v.id
    LEFT JOIN payment_totals pt ON pt.account_id = a.id LEFT JOIN account_refunds ar ON ar.account_id = a.id
    WHERE v.location_id = ${range.locationId} AND v.opened_at >= ${range.from} AND v.opened_at < ${range.to}
    GROUP BY v.staff_id, s.first_name, s.last_name ORDER BY gross_sales DESC, s.last_name, s.first_name
  `);

export const ordersSummary = (trx: DatabaseTransaction, range: ReportRange) =>
  run(trx, sql`
    WITH eligible_orders AS (
      SELECT id, visit_id FROM orders WHERE location_id = ${range.locationId}
        AND created_at >= ${range.from} AND created_at < ${range.to} AND status NOT IN ('CANCELLED', 'REJECTED')
    ), totals AS (
      SELECT count(*)::bigint AS order_count FROM eligible_orders
    ), ticket AS (
      SELECT coalesce(sum(a.total), 0)::bigint AS total FROM accounts a
      WHERE a.location_id = ${range.locationId} AND EXISTS (SELECT 1 FROM eligible_orders o WHERE o.visit_id = a.visit_id)
    ) SELECT totals.order_count, ticket.total AS total_sales FROM totals CROSS JOIN ticket
  `);

export const paymentsByMethod = (trx: DatabaseTransaction, range: ReportRange) =>
  run(trx, sql`
    SELECT method, sum(amount)::bigint AS total_collected FROM payments
    WHERE location_id = ${range.locationId} AND status = 'COMPLETED' AND created_at >= ${range.from} AND created_at < ${range.to}
    GROUP BY method ORDER BY method
  `);

export const discounts = (trx: DatabaseTransaction, range: ReportRange) =>
  run(trx, sql`
    SELECT discount_type, reason, count(*)::bigint AS count, sum(computed_amount)::bigint AS total_discount
    FROM account_discounts WHERE location_id = ${range.locationId} AND created_at >= ${range.from} AND created_at < ${range.to}
    GROUP BY discount_type, reason ORDER BY discount_type, reason
  `);

export const voidsAndCancellations = (trx: DatabaseTransaction, range: ReportRange) =>
  run(trx, sql`
    SELECT operation_type, reason, count(*)::bigint AS count, sum(amount)::bigint AS value
    FROM cancellations_and_voids WHERE location_id = ${range.locationId} AND created_at >= ${range.from} AND created_at < ${range.to}
    GROUP BY operation_type, reason ORDER BY operation_type, reason
  `);

export const refunds = (trx: DatabaseTransaction, range: ReportRange) =>
  run(trx, sql`
    SELECT reason, count(*)::bigint AS count, sum(amount)::bigint AS value FROM refunds
    WHERE location_id = ${range.locationId} AND created_at >= ${range.from} AND created_at < ${range.to}
    GROUP BY reason ORDER BY reason
  `);

export const tips = (trx: DatabaseTransaction, range: ReportRange) =>
  run(trx, sql`
    SELECT coalesce(sum(tip_amount), 0)::bigint AS total_tips FROM payments
    WHERE location_id = ${range.locationId} AND status = 'COMPLETED' AND created_at >= ${range.from} AND created_at < ${range.to}
  `);
