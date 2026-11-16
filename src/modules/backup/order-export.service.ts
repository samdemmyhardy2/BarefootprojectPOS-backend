import { BadRequestException, Injectable } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { OrderPaymentMethod, OrderPaymentStatus, OrderStatus, OrderType } from 'prisma/generated/prisma/enums';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { moneyRound, totalWithVat } from '../../common/vat';
import { bangkokClock, bangkokDayKey } from '../rooms/cloudbeds-email';

const MONEY = '#,##0.00';
const PAYMENTS = ['Cash', 'QR', 'Room tab', 'Card'] as const;
type Payment = (typeof PAYMENTS)[number] | 'Unpaid' | 'Cancelled';

const exportInclude = {
  table: { select: { tableNumber: true } },
  roomStay: { select: { room: { select: { roomNumber: true } } } },
  waiter: { select: { name: true } },
  roomCharge: { select: { createdAt: true } },
  items: { select: { id: true, quantity: true, subtotal: true, removedAt: true, itemSnapshot: true, menuItem: { select: { name: true } } } },
} satisfies Prisma.OrderInclude;
type ExportOrder = Prisma.OrderGetPayload<{ include: typeof exportInclude }>;

function snapshotText(snapshot: unknown, key: string) {
  const value = snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** Same groups as the order history totals: room tab covers folio orders and room checkouts. */
function payment(order: ExportOrder): Payment {
  if (order.status === OrderStatus.CANCELLED) return 'Cancelled';
  if (order.paymentStatus === OrderPaymentStatus.ROOM_FOLIO || (order.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && order.paymentStatus !== OrderPaymentStatus.UNPAID)) return 'Room tab';
  if (order.paymentStatus !== OrderPaymentStatus.PAID) return 'Unpaid';
  if (order.paymentMethod === OrderPaymentMethod.PROMPTPAY) return 'QR';
  if (order.paymentMethod === OrderPaymentMethod.CARD) return 'Card';
  return 'Cash';
}

/** Table numbers are stored as "Table 4" or "4"; show "Table 4" either way. */
function tableLabel(number: string) {
  return /^table\b/i.test(number.trim()) ? number.trim() : `Table ${number.trim()}`;
}

function tableNumber(order: ExportOrder) {
  return snapshotText(order.tableSnapshot, 'tableNumber') || order.table?.tableNumber || '';
}

function place(order: ExportOrder) {
  const room = order.roomStay?.room?.roomNumber;
  if (order.type === OrderType.ROOM_SERVICE) return room ? `Room service · Room ${room}` : 'Room service';
  const table = tableNumber(order);
  if (table) return tableLabel(table);
  return room ? `Room ${room}` : order.type === OrderType.PICKUP ? 'Pickup' : 'Walk-in';
}

/** Guest rooms the order was charged or seated with, like the order history "Room 5 · On tab" line. */
function guestNames(order: ExportOrder) {
  const snapshot = Array.isArray(order.roomGuestsSnapshot) ? order.roomGuestsSnapshot as { guestName?: unknown; guestNames?: unknown }[] : [];
  const names = snapshot.flatMap((guest) => !guest ? [] : Array.isArray(guest.guestNames) ? guest.guestNames.filter((name): name is string => typeof name === 'string' && name.trim() !== '') : typeof guest.guestName === 'string' && guest.guestName.trim() ? [guest.guestName] : []);
  return [...new Set(names)];
}

function rooms(order: ExportOrder) {
  const snapshot = Array.isArray(order.roomGuestsSnapshot) ? order.roomGuestsSnapshot as { roomNumber?: unknown }[] : [];
  const numbers = [...new Set(snapshot.map((guest) => guest?.roomNumber).filter((number) => number != null && `${number as string}` !== '').map((number) => `Room ${number as string}`))];
  if (numbers.length) return numbers;
  return order.roomStay?.room ? [`Room ${order.roomStay.room.roomNumber}`] : [];
}

function billPayment(method: string | null): Payment {
  if (method === OrderPaymentMethod.ROOM_CHECKOUT) return 'Room tab';
  if (method === OrderPaymentMethod.PROMPTPAY) return 'QR';
  if (method === OrderPaymentMethod.CARD) return 'Card';
  return 'Cash';
}

function dishName(item: ExportOrder['items'][number]) {
  return item.menuItem?.name ?? (snapshotText(item.itemSnapshot, 'name') || 'Dish');
}

/** "2× Latte, 1× Big water": the same dish across orders is counted once. */
function dishList(dishes: { name: string; quantity: number }[]) {
  const counts = new Map<string, number>();
  for (const dish of dishes) counts.set(dish.name, (counts.get(dish.name) ?? 0) + dish.quantity);
  return [...counts].map(([name, quantity]) => `${quantity}× ${name}`).join(', ');
}

export type ExportBill = { id: string; number: number; method: string | null; amount: number; paidAt: Date | null; room: string | null; guest: string | null; lines: { orderId: string; orderItemId: string; name: string; amount: number }[] };

/** One paid amount behind a row: a whole order, the unpaid rest of a split order, or one split bill. */
type Dish = { name: string; quantity: number; price: number };
type Part = { payment: Payment; order: ExportOrder; food: number; total: number; dishes: Dish[]; rooms: string[]; bill?: ExportBill };

/** When the guest paid: the cash, card, or QR payment time, or when the order went onto a room tab. */
function settledAt(part: Part) {
  if (part.bill) return part.bill.paidAt;
  if (part.payment === 'Unpaid' || part.payment === 'Cancelled') return null;
  return part.order.paidAt ?? part.order.roomCharge?.createdAt ?? part.order.updatedAt;
}

/** Orders paid in one checkout are stamped within the same transaction, a few milliseconds apart. */
const SAME_CHECKOUT_MS = 5_000;

export type Transaction = { day: string; parts: Part[]; row: (string | number)[] };

/**
 * One row per transaction. Orders of one table placed on one day and paid together in one checkout form one row; the next
 * guests at that table are a new row. A split bill is its own transaction. Unpaid orders of a table are one open row per day.
 * A tab left open for several days and checked out once still shows one row on each day, so each order stays on its own day.
 */
function transactions(orders: ExportOrder[], bills: ExportBill[]): Transaction[] {
  const seen = new Set<string>();
  const parts: Part[] = [];
  for (const order of orders) {
    if (order.status === OrderStatus.CANCELLED) {
      parts.push({ payment: 'Cancelled', order, food: 0, total: 0, dishes: [], rooms: rooms(order) });
      continue;
    }
    const mine = bills.filter((bill) => bill.lines.some((line) => line.orderId === order.id));
    const taken = new Map<string, number>();
    for (const bill of mine) for (const line of bill.lines) if (line.orderId === order.id) taken.set(line.orderItemId, (taken.get(line.orderItemId) ?? 0) + 1);
    for (const bill of mine) {
      if (seen.has(bill.id)) continue;
      seen.add(bill.id);
      const food = moneyRound(bill.lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0));
      parts.push({ payment: billPayment(bill.method), order, food, total: bill.amount, dishes: bill.lines.map((line) => ({ name: line.name, quantity: 1, price: moneyRound(Number(line.amount) || 0) })), rooms: bill.room ? [`Room ${bill.room}`] : rooms(order), bill });
    }
    const active = order.items.filter((item) => !item.removedAt);
    const left = active.flatMap((item) => {
      const quantity = item.quantity - (taken.get(item.id) ?? 0);
      return quantity > 0 ? [{ name: dishName(item), quantity, amount: moneyRound((Number(item.subtotal) / (item.quantity || 1)) * quantity) }] : [];
    });
    if (taken.size && !left.length) continue;
    const food = taken.size ? moneyRound(left.reduce((sum, dish) => sum + dish.amount, 0)) : moneyRound(Number(order.totalAmount));
    parts.push({ payment: payment(order), order, food, total: totalWithVat(food, Number(order.vatPercent)), dishes: left.map((dish) => ({ name: dish.name, quantity: dish.quantity, price: dish.amount })), rooms: rooms(order) });
  }

  const groups: { parts: Part[]; table: string; payment: Payment; paidAt: number | null }[] = [];
  for (const part of parts) {
    // Split sides of one table ("4A", "4B") are separate payers.
    const table = !part.bill && part.payment !== 'Cancelled' ? `${part.order.tableId ?? ''}:${tableNumber(part.order)}` : '';
    const paid = settledAt(part)?.getTime() ?? null;
    const day = bangkokDayKey(part.order.createdAt);
    const match = table && groups.find((group) => group.table === table && group.payment === part.payment && bangkokDayKey(group.parts[0].order.createdAt) === day
      && (paid === null ? group.paidAt === null : group.paidAt !== null && Math.abs(group.paidAt - paid) <= SAME_CHECKOUT_MS));
    if (match) match.parts.push(part);
    else groups.push({ parts: [part], table, payment: part.payment, paidAt: paid });
  }

  const unique = (values: string[]) => [...new Set(values.filter(Boolean))].join(', ');
  return groups.map(({ parts: group, paidAt }) => {
    const first = group[0];
    const bill = first.bill;
    const day = bangkokDayKey(first.order.createdAt);
    const food = moneyRound(group.reduce((sum, part) => sum + part.food, 0));
    const total = moneyRound(group.reduce((sum, part) => sum + part.total, 0));
    const paid = paidAt === null ? '' : bangkokDayKey(new Date(paidAt)) === day ? bangkokClock(new Date(paidAt)) : `${bangkokDayKey(new Date(paidAt))} ${bangkokClock(new Date(paidAt))}`;
    const row = [
      day,
      bangkokClock(first.order.createdAt),
      paid,
      bill ? `Bill ${bill.number} (#${first.order.number})` : group.map((part) => `#${part.order.number}`).join(', '),
      place(first.order),
      unique(group.flatMap((part) => part.rooms)) || 'Walk-in',
      unique(group.map((part) => part.order.waiter.name)),
      bill ? 'Paid' : unique(group.map((part) => part.order.status)),
      unique(group.map((part) => part.payment)),
      dishList(group.flatMap((part) => part.dishes)),
      food,
      moneyRound(total - food),
      total,
    ];
    return { day, parts: group, row };
  });
}

type Sum = { count: number; food: number; total: number };
type Day = { key: string; transactions: Transaction[]; commission: { count: number; amount: number } };
const ORDER_HEADER = ['Date', 'First order', 'Paid at', 'Orders', 'Place', 'Room', 'Waiter', 'Status', 'Payment', 'Items', 'Food', 'VAT', 'Total'];
const ROOM_TAB_HEADER = ['Order', 'Item Name', 'Price', 'Room', 'Guest', 'Place', 'Date', 'Signature'];
const ROOM_SHEET_HEADER = ['Order', 'Item Name', 'Price', 'Place', 'Date', 'Signature'];

function bangkokDayStart(now = new Date()) {
  const shifted = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - BANGKOK_OFFSET_MS);
}

/** Excel sheet names allow 31 characters and reject \\ / ? * [ ] : */
function excelSheetName(value: string) {
  const cleaned = value.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  return cleaned || 'Room';
}
const SUMMARY_HEADER = ['Date', 'Orders', 'Total', 'Cash', 'QR', 'Room tab', 'Card', 'Commission', 'Unpaid', 'Cancelled orders'];
const DAY_MS = 24 * 60 * 60 * 1000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Money cells get a number format so Excel sums them. */
function sheet(rows: (string | number)[][], widths: number[], moneyColumns: number[]) {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  for (let row = 0; row < rows.length; row += 1) {
    for (const column of moneyColumns) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined;
      if (cell?.t === 'n') cell.z = MONEY;
    }
  }
  worksheet['!cols'] = widths.map((wch) => ({ wch }));
  return worksheet;
}

const empty = (): Sum => ({ count: 0, food: 0, total: 0 });
const add = (sum: Sum, food: number, total: number): Sum => ({ count: sum.count + 1, food: moneyRound(sum.food + food), total: moneyRound(sum.total + total) });

/** Orders and totals of one restaurant day (00:00:00 to 23:59:59, Asia/Bangkok). */
function daySheet(day: Day) {
  const rows = day.transactions.map((transaction) => transaction.row);
  const totals = new Map<Payment, Sum>();
  for (const part of day.transactions.flatMap((transaction) => transaction.parts)) totals.set(part.payment, add(totals.get(part.payment) ?? empty(), part.food, part.total));
  const grand = [...PAYMENTS, 'Unpaid' as const].reduce<Sum>((all, key) => {
    const value = totals.get(key) ?? empty();
    return { count: all.count + value.count, food: moneyRound(all.food + value.food), total: moneyRound(all.total + value.total) };
  }, empty());
  const line = (label: string, value: Sum = empty()) => ['', '', '', '', '', '', '', '', label, value.count, value.food, moneyRound(value.total - value.food), value.total];
  const block: (string | number)[][] = [
    [],
    ['', '', '', '', '', '', '', '', 'Payment', 'Orders', 'Food', 'VAT', 'Total'],
    line('Total', grand),
    line('Cash', totals.get('Cash')),
    line('QR', totals.get('QR')),
    line('Room tab', totals.get('Room tab')),
    line('Card', totals.get('Card')),
    ['', '', '', '', '', '', '', '', 'Commission', day.commission.count, '', '', day.commission.amount],
    line('Unpaid (in Total)', totals.get('Unpaid')),
    line('Cancelled (not in Total)', totals.get('Cancelled')),
  ];
  const summary = [day.key, grand.count, grand.total, totals.get('Cash')?.total ?? 0, totals.get('QR')?.total ?? 0, totals.get('Room tab')?.total ?? 0, totals.get('Card')?.total ?? 0, day.commission.amount, totals.get('Unpaid')?.total ?? 0, totals.get('Cancelled')?.count ?? 0];
  const content: (string | number)[][] = rows.length ? [ORDER_HEADER, ...rows] : [ORDER_HEADER, ['', '', '', 'No orders this day']];
  return { worksheet: sheet([...content, ...block], [11, 11, 11, 18, 14, 14, 14, 16, 22, 60, 11, 9, 11], [10, 11, 12]), summary };
}

@Injectable()
export class OrderExportService {
  constructor(private readonly prisma: PrismaService) {}

  /** Settled split bills of these orders' tables, with the room each bill was charged to. */
  private async settledBills(orders: ExportOrder[]): Promise<ExportBill[]> {
    const tableIds = [...new Set(orders.map((order) => order.tableId).filter((id): id is string => Boolean(id)))];
    if (!tableIds.length) return [];
    const bills = await this.prisma.tableBill.findMany({ where: { tableId: { in: tableIds }, status: 'SETTLED' }, orderBy: { number: 'asc' } });
    const stayIds = [...new Set(bills.map((bill) => bill.stayId).filter((id): id is string => Boolean(id)))];
    const stays = stayIds.length ? await this.prisma.roomStay.findMany({ where: { id: { in: stayIds } }, select: { id: true, primaryGuestName: true, room: { select: { roomNumber: true } } } }) : [];
    return bills.map((bill) => ({
      id: bill.id,
      number: bill.number,
      method: bill.method,
      amount: moneyRound(Number(bill.amount)),
      paidAt: bill.paidAt,
      room: stays.find((stay) => stay.id === bill.stayId)?.room?.roomNumber ?? null,
      guest: stays.find((stay) => stay.id === bill.stayId)?.primaryGuestName ?? null,
      lines: (Array.isArray(bill.lines) ? bill.lines as ExportBill['lines'] : []).filter((line) => line && typeof line.orderId === 'string'),
    }));
  }

  /** Restaurant days from firstDay through today, Asia/Bangkok, with their transactions filled in. */
  private async daily(firstDay: string) {
    const start = Date.parse(`${firstDay}T00:00:00Z`) - BANGKOK_OFFSET_MS;
    if (Number.isNaN(start)) throw new BadRequestException('The first backup day must be YYYY-MM-DD');
    const from = new Date(start);
    const today = bangkokDayKey(new Date());
    const days: Day[] = [];
    for (let at = start; bangkokDayKey(new Date(at)) <= today; at += DAY_MS) days.push({ key: bangkokDayKey(new Date(at)), transactions: [], commission: { count: 0, amount: 0 } });
    const byKey = new Map(days.map((day) => [day.key, day]));
    const [orders, commissions] = await Promise.all([
      this.prisma.order.findMany({ where: { createdAt: { gte: from } }, orderBy: { createdAt: 'asc' }, include: exportInclude }),
      this.prisma.roomCharge.findMany({ where: { commissionAmount: { not: null }, settledAt: { gte: from } }, select: { commissionAmount: true, settledAt: true } }),
    ]);
    for (const transaction of transactions(orders, await this.settledBills(orders))) byKey.get(transaction.day)?.transactions.push(transaction);
    for (const charge of commissions) {
      const day = charge.settledAt && byKey.get(bangkokDayKey(charge.settledAt));
      if (day) day.commission = { count: day.commission.count + 1, amount: moneyRound(day.commission.amount + Number(charge.commissionAmount ?? 0)) };
    }
    return { today, days };
  }

  /** A Summary sheet, then one sheet per restaurant day from firstDay (YYYY-MM-DD) to today, Asia/Bangkok. */
  async workbook(firstDay: string) {
    const { today, days } = await this.daily(firstDay);

    const book = XLSX.utils.book_new();
    const sheets = days.map((day) => ({ key: day.key, ...daySheet(day) }));
    const summaryRows: (string | number)[][] = [SUMMARY_HEADER, ...sheets.map((entry) => entry.summary)];
    const columnTotal = (column: number) => moneyRound(sheets.reduce((sum, entry) => sum + Number(entry.summary[column]), 0));
    summaryRows.push(['All days', ...SUMMARY_HEADER.slice(1).map((_, index) => columnTotal(index + 1))]);
    summaryRows.push([], ['Days run 00:00:00 to 23:59:59, Asia/Bangkok. Cancelled orders are not in Total. Commission is by payment date and not part of Total.'], ['Updated', `${today} ${bangkokClock(new Date())}`]);
    XLSX.utils.book_append_sheet(book, sheet(summaryRows, [12, 8, 12, 12, 12, 12, 12, 12, 12, 16], [2, 3, 4, 5, 6, 7, 8]), 'Summary');
    for (const entry of sheets) XLSX.utils.book_append_sheet(book, entry.worksheet, entry.key);
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  /** Room-tab charges saved without a guest signature. The name is enough; the image stays out of the export. */
  private async unsignedMarks() {
    const charges = await this.prisma.roomCharge.findMany({ select: { orderId: true, billId: true, signedByName: true } });
    const missing = (value: string | null) => !value?.trim();
    return {
      orders: new Set(charges.flatMap((charge) => charge.orderId && missing(charge.signedByName) ? [charge.orderId] : [])),
      bills: new Set(charges.flatMap((charge) => charge.billId && missing(charge.signedByName) ? [charge.billId] : [])),
    };
  }

  /** One sheet per occupied room. The sheet is named Room 1, Room 2, and so on. Unsigned sits at the top when any tab order has no signature. */
  private async inHouseSheets() {
    const now = new Date();
    const stays = await this.prisma.roomStay.findMany({
      where: {
        cancelledAt: null,
        checkedOutAt: null,
        roomId: { not: null },
        checkedInAt: { lte: now },
        OR: [{ expectedCheckoutAt: null }, { expectedCheckoutAt: { gte: bangkokDayStart(now) } }],
      },
      select: {
        primaryGuestName: true,
        room: { select: { roomNumber: true } },
        orders: {
          where: { status: { not: OrderStatus.CANCELLED } },
          orderBy: { createdAt: 'asc' },
          select: {
            number: true,
            createdAt: true,
            type: true,
            paymentMethod: true,
            paymentStatus: true,
            table: { select: { tableNumber: true } },
            items: { where: { removedAt: null }, select: { id: true, quantity: true, subtotal: true, itemSnapshot: true, menuItem: { select: { name: true } } } },
            roomCharge: { select: { signedByName: true, billNumber: true, lines: true, occurredAt: true } },
          },
        },
        charges: {
          where: { kind: 'RESTAURANT_ORDER', orderId: null },
          select: { description: true, amount: true, signedByName: true, billNumber: true, lines: true, occurredAt: true },
        },
      },
    });
    const byRoom = [...stays].sort((left, right) => String(left.room?.roomNumber ?? '').localeCompare(String(right.room?.roomNumber ?? ''), undefined, { numeric: true }));
    const grouped = new Map<string, typeof byRoom>();
    for (const stay of byRoom) {
      const number = String(stay.room?.roomNumber ?? 'Unassigned');
      grouped.set(number, [...(grouped.get(number) ?? []), stay]);
    }
    const used = new Set<string>();
    const sheets: { name: string; rows: (string | number)[][] }[] = [];
    for (const [number, roomStays] of grouped) {
      const title = `Room ${number}`;
      let name = excelSheetName(title);
      while (used.has(name)) name = excelSheetName(`${title} ${used.size + 1}`);
      used.add(name);
      const blocks: (string | number)[][][] = [];
      let unsigned = false;
      for (const stay of roomStays) {
        const room = title;
        const lines: (string | number)[][] = [];
        const covered = new Set<string>();
        const pushLines = (label: string, when: Date, where: string, signature: string, stored: unknown) => {
          const dishes = Array.isArray(stored) ? stored as { name?: unknown; quantity?: unknown; amount?: unknown; orderItemId?: unknown; removedAt?: unknown }[] : [];
          const visible = dishes.filter((line) => line && typeof line.name === 'string' && !line.removedAt);
          for (const line of visible) if (typeof line.orderItemId === 'string') covered.add(line.orderItemId);
          if (!visible.length) return false;
          for (const line of visible) {
            const quantity = Number(line.quantity) > 0 ? Number(line.quantity) : 1;
            lines.push([label, quantity === 1 ? String(line.name) : `${quantity}× ${line.name}`, moneyRound(Number(line.amount) || 0), where, bangkokDayKey(when), signature]);
          }
          return true;
        };
        for (const order of stay.orders) {
          const onTab = order.paymentStatus === OrderPaymentStatus.ROOM_FOLIO || (order.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && order.paymentStatus !== OrderPaymentStatus.UNPAID);
          const signature = !onTab ? '' : order.roomCharge?.signedByName?.trim() ? 'Signed' : 'Unsigned';
          const where = order.type === OrderType.ROOM_SERVICE ? `Room service · ${room}` : order.table?.tableNumber ? tableLabel(order.table.tableNumber) : room;
          const label = order.roomCharge?.billNumber ? `Bill ${order.roomCharge.billNumber}` : `#${order.number}`;
          if (pushLines(label, order.roomCharge?.occurredAt ?? order.createdAt, where, signature, order.roomCharge?.lines)) continue;
          const dishes = order.items.filter((item) => item.quantity > 0 && !covered.has(item.id));
          if (dishes.length) {
            for (const item of dishes) {
              const dish = item.menuItem?.name ?? (snapshotText(item.itemSnapshot, 'name') || 'Dish');
              lines.push([`#${order.number}`, item.quantity === 1 ? dish : `${item.quantity}× ${dish}`, moneyRound(Number(item.subtotal)), where, bangkokDayKey(order.createdAt), signature]);
            }
          } else if (!order.items.length) lines.push([`#${order.number}`, 'No dishes', 0, where, bangkokDayKey(order.createdAt), signature]);
        }
        for (const charge of stay.charges) {
          const signature = charge.signedByName?.trim() ? 'Signed' : 'Unsigned';
          const label = charge.billNumber ? `Bill ${charge.billNumber}` : 'Room tab';
          if (!pushLines(label, charge.occurredAt, room, signature, charge.lines)) lines.push([label, charge.description, moneyRound(Number(charge.amount)), room, bangkokDayKey(charge.occurredAt), signature]);
        }
        if (lines.some((line) => line[5] === 'Unsigned')) unsigned = true;
        const total = moneyRound(lines.reduce((sum, line) => sum + (typeof line[2] === 'number' ? line[2] : 0), 0));
        blocks.push([[stay.primaryGuestName], ROOM_SHEET_HEADER, ...(lines.length ? lines : [['', 'No orders', '', '', '', '']]), ['', 'Total', total]]);
      }
      const rows: (string | number)[][] = [[title], ...(unsigned ? [['Unsigned']] : []), []];
      for (const block of blocks) rows.push(...block, []);
      sheets.push({ name, rows });
    }
    return sheets;
  }

  /**
   * One order number per guest at a table, across previous room-tab history. Each dish is its own row.
   * The number is the earliest order that guest placed at that table.
   * Each guest still checked in gets a sheet named for that room. Unsigned is written at the top when any tab order has no signature.
   */
  async roomTabWorkbook(firstDay: string) {
    const { today, days } = await this.daily(firstDay);
    const unsigned = await this.unsignedMarks();
    const groups = new Map<string, { numbers: number[]; items: { name: string; price: number; at: Date; room: string; guest: string; place: string; signature: string }[] }>();
    for (const day of days) {
      for (const transaction of day.transactions) {
        if (transaction.parts[0]?.payment !== 'Room tab') continue;
        for (const part of transaction.parts) {
          const room = [...new Set(part.rooms.filter(Boolean))].join(', ') || 'Walk-in';
          const guest = part.bill?.guest || guestNames(part.order).join(', ');
          const where = place(part.order);
          const key = `${room}\0${guest}\0${where}`;
          const group = groups.get(key) ?? { numbers: [], items: [] };
          group.numbers.push(part.order.number);
          const missing = part.bill ? unsigned.bills.has(part.bill.id) : unsigned.orders.has(part.order.id);
          for (const dish of part.dishes) {
            if (dish.quantity <= 0) continue;
            group.items.push({ name: dish.quantity === 1 ? dish.name : `${dish.quantity}× ${dish.name}`, price: dish.price, at: part.order.createdAt, room, guest, place: where, signature: missing ? 'Unsigned' : 'Signed' });
          }
          groups.set(key, group);
        }
      }
    }
    const used = new Set<number>();
    const ordered = [...groups.values()].filter((group) => group.items.length > 0).sort((left, right) => Math.min(...left.numbers) - Math.min(...right.numbers) || left.items[0].room.localeCompare(right.items[0].room));
    const assigned = ordered.map((group) => {
      const numbers = [...new Set(group.numbers)].sort((left, right) => left - right);
      const free = numbers.find((number) => !used.has(number));
      const orderNumber = free ?? numbers[0];
      if (free != null) used.add(free);
      const label = free == null ? `${numbers[0]} · ${group.items[0].room}` : orderNumber;
      return { label, items: group.items };
    });
    const rows = assigned
      .sort((left, right) => String(left.label).localeCompare(String(right.label), undefined, { numeric: true }))
      .flatMap((group) => group.items
        .sort((left, right) => left.at.getTime() - right.at.getTime() || left.name.localeCompare(right.name))
        .map((item) => [group.label, item.name, item.price, item.room, item.guest, item.place, bangkokDayKey(item.at), item.signature]));
    const total = moneyRound(rows.reduce((sum, row) => sum + Number(row[2]), 0));
    const content: (string | number)[][] = rows.length ? [ROOM_TAB_HEADER, ...rows] : [ROOM_TAB_HEADER, ['', 'No room tab orders']];
    content.push([], ['', 'Total', total, '', '', '', '', `${assigned.length} orders`], [], ['One order number is one guest at one table. Each dish is its own row. Unsigned means the dish is on the room tab and still needs a signature. Prices are THB.'], ['Updated', `${today} ${bangkokClock(new Date())}`]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet(content, [10, 36, 12, 16, 24, 22, 12, 12], [2]), 'Room tabs');
    for (const room of await this.inHouseSheets()) XLSX.utils.book_append_sheet(book, sheet(room.rows, [14, 36, 12, 28, 12, 12], [2]), room.name);
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }
}
