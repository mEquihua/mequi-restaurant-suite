/** Converts integer-cent aggregates into a stable average ticket value. */
export function averageTicket(totalCents: number, orderCount: number): number {
  return orderCount === 0 ? 0 : totalCents / orderCount;
}

/** Serializes flat report rows without introducing a second database query path. */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((row) => row.map(escape).join(','))
    .join('\n');
}
