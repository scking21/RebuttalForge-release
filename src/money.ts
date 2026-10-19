import type { Money } from './domain.js';

// PayPal's supported-currencies reference, checked 2026-10-10:
// https://developer.paypal.com/reports/reference/supported-currencies
const TWO_DIGIT = new Set('AUD BRL CAD CNY CZK DKK EUR HKD ILS MYR MXN NZD NOK PHP PLN GBP SGD SEK CHF THB USD'.split(' '));
const ZERO_DIGIT = new Set(['HUF', 'JPY', 'TWD']);

export function minorUnits(money: Money): bigint | undefined {
  if (!money || typeof money.currency_code !== "string" || typeof money.value !== "string") return undefined;
  const scale = ZERO_DIGIT.has(money.currency_code) ? 0 : TWO_DIGIT.has(money.currency_code) ? 2 : undefined;
  if (scale === undefined || money.value.length > 32) return undefined;
  const pattern = scale === 0 ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/;
  if (!pattern.test(money.value)) return undefined;
  const [whole, fraction = ''] = money.value.split('.');
  return BigInt(whole!) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
}
