export type AvailabilityStatus = 'AVAILABLE' | 'EXHAUSTED' | 'HIDDEN' | 'SCHEDULED';

export interface AvailabilityRuleInput {
  status: AvailabilityStatus;
  channel_scope: string | null;
  service_type_scope: string | null;
  days_of_week: number[] | null;
  start_time: Date | null;
  end_time: Date | null;
}

export interface AvailabilityContext {
  channel?: string;
  serviceType?: string;
  now: Date;
}

function isoWeekday(value: Date): number {
  const day = value.getUTCDay();
  return day === 0 ? 7 : day;
}

function applies(rule: AvailabilityRuleInput, context: AvailabilityContext): boolean {
  if (rule.channel_scope !== null && rule.channel_scope !== context.channel) return false;
  if (rule.service_type_scope !== null && rule.service_type_scope !== context.serviceType) return false;
  if (rule.days_of_week !== null && !rule.days_of_week.includes(isoWeekday(context.now))) return false;
  if (rule.start_time !== null && rule.start_time > context.now) return false;
  if (rule.end_time !== null && rule.end_time < context.now) return false;
  return true;
}

/** Resolves the most specific active location rule without letting one channel affect another. */
export function resolveAvailability(rules: readonly AvailabilityRuleInput[], context: AvailabilityContext): { status: AvailabilityStatus; available: boolean } {
  const matching = rules.filter((rule) => applies(rule, context));
  matching.sort((a, b) => {
    const score = (rule: AvailabilityRuleInput) => Number(rule.channel_scope !== null) + Number(rule.service_type_scope !== null) + Number(rule.days_of_week !== null) + Number(rule.start_time !== null || rule.end_time !== null);
    return score(b) - score(a);
  });
  const status = matching[0]?.status ?? 'AVAILABLE';
  return { status, available: status === 'AVAILABLE' };
}

export function effectivePrice(basePrice: number, overridePrice: number | null | undefined): number {
  return overridePrice ?? basePrice;
}
