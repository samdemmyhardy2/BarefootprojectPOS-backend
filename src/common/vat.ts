export function moneyRound(value: number) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

export function vatAmount(subtotal: number, percent: number) {
  const rate = Number(percent);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return moneyRound(moneyRound(subtotal) * rate / 100);
}

export function exactTotalWithVat(subtotal: number, percent: number) {
  return moneyRound(moneyRound(subtotal) + vatAmount(subtotal, percent));
}

/** 516.14 becomes 517. A whole baht, and any amount without VAT, stays as it is. */
export function roundUpBaht(value: number) {
  const cents = Math.round(moneyRound(value) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  if (cents % 100 === 0) return cents / 100;
  return Math.floor(cents / 100) + 1;
}

export function totalWithVat(subtotal: number, percent: number) {
  const exact = exactTotalWithVat(subtotal, percent);
  return Number(percent) > 0 ? roundUpBaht(exact) : exact;
}

/** VAT on each dish, then one total. A whole baht stays as it is. */
export function dishVat(amounts: number[], percent: number) {
  return moneyRound(amounts.reduce((sum, amount) => sum + vatAmount(amount, percent), 0));
}

export function totalWithDishVat(amounts: number[], percent: number) {
  const food = moneyRound(amounts.reduce((sum, amount) => sum + (Number(amount) || 0), 0));
  if (!(Number(percent) > 0) || !amounts.length) return food;
  return roundUpBaht(moneyRound(food + dishVat(amounts, percent)));
}

/** New charge total when a saved rate should be applied, or null when the amount was adjusted by hand. */
export function restaurantChargeGrand(current: number, food: number, previousPercent: number, nextPercent: number) {
  const amount = moneyRound(current);
  const base = moneyRound(food);
  const nextExact = exactTotalWithVat(base, nextPercent);
  const previousExact = exactTotalWithVat(base, previousPercent);
  const next = Number(nextPercent) > 0 ? roundUpBaht(nextExact) : nextExact;
  const previousShown = Number(previousPercent) > 0 ? roundUpBaht(previousExact) : previousExact;
  const close = (left: number, right: number) => Math.abs(moneyRound(left - right)) < 0.02;
  const matched = close(amount, base) || close(amount, previousExact) || close(amount, previousShown) || close(amount, nextExact) || close(amount, next);
  if (!matched || close(amount, next)) return null;
  if (close(moneyRound(previousPercent), moneyRound(nextPercent))) return null;
  return next;
}

type ChargeDueLine = { amount?: unknown; removedAt?: unknown; orderItemId?: unknown };
type ChargeDueItem = { subtotal?: unknown; unitPrice?: unknown; quantity?: unknown; removedAt?: unknown };

function groupedDishAmounts(lines: { key: string; amount: number }[]) {
  const groups = new Map<string, number>();
  lines.forEach((line) => groups.set(line.key, moneyRound((groups.get(line.key) ?? 0) + line.amount)));
  return [...groups.values()];
}
type ChargeDueOrder = { vatPercent?: unknown; items?: ChargeDueItem[] };

/** Guest total for one room charge. Restaurant food that does not already include VAT has VAT added. */
export function chargeDue(input: { amount: unknown; kind?: string | null; lines?: unknown; order?: ChargeDueOrder | null }, settingsRate = 0) {
  const stored = moneyRound(Number(input.amount) || 0);
  const lines = Array.isArray(input.lines) ? input.lines.flatMap((line) => (line && typeof line === 'object' ? [line as ChargeDueLine] : [])) : [];
  const activeLines = lines.filter((line) => !line.removedAt);
  const lined = lines.length ? moneyRound(activeLines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0)) : null;
  const items = input.order?.items ?? [];
  const activeItems = items.filter((item) => !item.removedAt);
  const itemDishes = activeItems.map((item) => Number(item.subtotal ?? Number(item.unitPrice ?? 0) * Number(item.quantity ?? 0)));
  const itemFood = input.order ? moneyRound(itemDishes.reduce((sum, amount) => sum + amount, 0)) : null;
  const restaurant = input.kind === 'RESTAURANT_ORDER' || lined !== null || Boolean(input.order);
  const declared = Number(input.order?.vatPercent) || 0;
  const percent = declared > 0 ? declared : Number(settingsRate) || 0;
  let food = stored;
  if (lined !== null) food = lined;
  else if (itemFood !== null) {
    const withRate = moneyRound(itemFood + vatAmount(itemFood, percent));
    const withDishes = moneyRound(itemFood + dishVat(itemDishes, percent));
    if (Math.abs(stored - itemFood) < 0.02 || Math.abs(stored - withRate) < 0.02 || Math.abs(stored - withDishes) < 0.02) food = itemFood;
  }
  if (!restaurant) return { food: stored, vat: 0, total: stored };
  const gap = moneyRound(stored - food);
  if (gap > 0.009) return { food, vat: gap, total: stored };
  const dishes = activeLines.length
    ? groupedDishAmounts(activeLines.map((line, index) => ({ key: String(line.orderItemId || index), amount: Number(line.amount) || 0 })))
    : itemDishes.length ? itemDishes : [food];
  const vat = dishVat(dishes, percent);
  return { food, vat, total: moneyRound(food + vat) };
}

export function folioPayable(charges: { amount: unknown; kind?: string | null; lines?: unknown; order?: ChargeDueOrder | null }[], settingsRate = 0) {
  const priced = charges.map((charge) => chargeDue(charge, settingsRate));
  const vat = moneyRound(priced.reduce((sum, row) => sum + row.vat, 0));
  const exact = moneyRound(priced.reduce((sum, row) => sum + row.total, 0));
  return vat > 0 ? roundUpBaht(exact) : exact;
}

export function billCharge(parts: { amount: number; vatPercent: number }[]) {
  const food = moneyRound(parts.reduce((sum, part) => sum + moneyRound(part.amount), 0));
  const rates = [...new Set(parts.map((part) => moneyRound(Number(part.vatPercent) || 0)))];
  if (rates.length <= 1) {
    const vat = vatAmount(food, rates[0] ?? 0);
    return { food, vat, total: moneyRound(food + vat), percent: rates[0] ?? 0 };
  }
  const vat = moneyRound(parts.reduce((sum, part) => sum + vatAmount(part.amount, part.vatPercent), 0));
  return { food, vat, total: moneyRound(food + vat), percent: rates[0] ?? 0 };
}

export function vatShares(parts: { amount: number; vatPercent: number }[]) {
  const bill = billCharge(parts);
  if (parts.length <= 1) return parts.map(() => bill.vat);
  const shares = parts.map((part) => vatAmount(part.amount, part.vatPercent));
  const drift = moneyRound(bill.vat - shares.reduce((sum, share) => sum + share, 0));
  if (shares.length) shares[shares.length - 1] = moneyRound(shares[shares.length - 1] + drift);
  return shares;
}
