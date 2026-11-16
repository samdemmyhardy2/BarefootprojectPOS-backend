import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { IdempotencyService } from '../../utils/prisma/idempotency.service';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { UpdateTableStatusDto } from './dto/update-table-status.dto';
import { CheckoutTableDto } from './dto/checkout-table.dto';
import { OrderPaymentMethod, OrderPaymentStatus, OrderStatus, PrepTicketStatus, TableShape, TableStatus } from 'prisma/generated/prisma/enums';
import { UpdateTableLayoutDto } from './dto/update-table-layout.dto';
import { SettlePartyDto } from './dto/settle-party.dto';
import { SaveBillSplitDto } from './dto/save-bill-split.dto';
import { SettleBillDto } from './dto/settle-bill.dto';
import { OrdersService } from '../orders/orders.service';
import { moneyRound } from '../../common/vat';

function dishName(line: { menuItem: { name: string } | null; itemSnapshot: Prisma.JsonValue }) {
  const copy = line.itemSnapshot && typeof line.itemSnapshot === 'object' && !Array.isArray(line.itemSnapshot) ? line.itemSnapshot as { name?: string } : {};
  return copy.name || line.menuItem?.name || 'item';
}

type BillLine = { orderId: string; orderItemId: string; unit: number; name: string; detail: string | null; amount: number };
type BillUnit = BillLine & { key: string };
const openStatuses = [OrderStatus.PENDING, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.SERVED];

function lineDetail(item: { modifierSelections: Prisma.JsonValue; specialNotes: string | null }) {
  const selections = Array.isArray(item.modifierSelections) ? item.modifierSelections as { options?: { name?: string }[] }[] : [];
  const choices = selections.map((selection) => (selection.options ?? []).map((option) => option.name).filter(Boolean).join(', ')).filter(Boolean).join(', ');
  return [choices, item.specialNotes].filter(Boolean).join(' · ') || null;
}

function unitsFor(orders: { id: string; items: { id: string; quantity: number; subtotal: Prisma.Decimal; specialNotes: string | null; modifierSelections: Prisma.JsonValue; itemSnapshot: Prisma.JsonValue; menuItem: { name: string } | null; removedAt?: Date | null }[] }[]): BillUnit[] {
  const units: BillUnit[] = [];
  for (const order of orders) {
    for (const item of order.items) {
      if (item.removedAt) continue;
      const quantity = Math.max(1, Math.round(item.quantity));
      const cents = Math.round(Number(item.subtotal) * 100);
      const base = Math.floor(cents / quantity);
      const extra = cents - base * quantity;
      const name = dishName(item);
      const detail = lineDetail(item);
      for (let unit = 0; unit < quantity; unit += 1) {
        units.push({ key: `${item.id}:${unit}`, orderId: order.id, orderItemId: item.id, unit, name, detail, amount: (base + (unit < extra ? 1 : 0)) / 100 });
      }
    }
  }
  return units;
}

function asLines(value: Prisma.JsonValue): BillLine[] {
  return Array.isArray(value) ? value as BillLine[] : [];
}

function guestSnapshot(stay: { primaryGuestName: string; occupants: { name: string }[]; room: { roomNumber: string } | null }) {
  return {
    roomNumber: stay.room?.roomNumber ?? 'Unassigned',
    guestName: stay.primaryGuestName,
    guestNames: [...new Set([stay.primaryGuestName, ...stay.occupants.map((person) => person.name)].filter(Boolean))],
  };
}

const tableSpan = (table: { width: number; height: number }) => ({ columns: table.width, rows: table.height });
const occupiedSlots = (positionX: number, positionY: number, width: number, height: number) => {
  const slots: string[] = [];
  for (let x = positionX; x < positionX + width; x += 1) {
    for (let y = positionY; y < positionY + height; y += 1) slots.push(`${x}:${y}`);
  }
  return slots;
};

@Injectable()
export class TablesService {
  constructor(private readonly prisma: PrismaService, private readonly idempotency: IdempotencyService, private readonly orders: OrdersService) {}
  findAll() { return this.prisma.table.findMany({ include: this.tableView(), orderBy: { tableNumber: 'asc' } }); }
  private tableView() {
    return { assignedRoomStays: { include: { room: true, occupants: true } }, splits: { orderBy: { position: 'asc' as const }, select: { id: true, label: true, roomStayId: true, position: true } } };
  }
  private async shownTable(id: string) {
    return this.prisma.table.findUniqueOrThrow({ where: { id }, include: this.tableView() });
  }
  findSections() {
    return this.prisma.floorSection.findMany({ orderBy: { position: 'asc' } });
  }
  async createSection(name: string) {
    const last = await this.prisma.floorSection.findFirst({ orderBy: { position: 'desc' }, select: { position: true } });
    return this.prisma.floorSection.create({ data: { name, position: (last?.position ?? -1) + 1 } });
  }
  private async sectionForNewTable(sectionId?: string) {
    if (sectionId) {
      const section = await this.prisma.floorSection.findUnique({ where: { id: sectionId }, select: { id: true } });
      if (!section) throw new NotFoundException('Floor section not found');
      return section.id;
    }
    const first = await this.prisma.floorSection.findFirst({ orderBy: { position: 'asc' }, select: { id: true } });
    if (!first) throw new NotFoundException('Floor section not found');
    return first.id;
  }
  async findOne(id: string) { const table = await this.prisma.table.findUnique({ where: { id }, include: { assignedRoomStays: { include: { room: true, occupants: true } } } }); if (!table) throw new NotFoundException('Table not found'); return table; }
  async create(dto: CreateTableDto) {
    const sectionId = await this.sectionForNewTable(dto.sectionId);
    const existing = await this.prisma.table.findMany({ where: { sectionId }, select: { positionX: true, positionY: true, width: true, height: true } });
    const shape = dto.shape ?? (dto.capacity <= 2 ? TableShape.ROUND : dto.capacity >= 8 ? TableShape.OVAL : TableShape.RECTANGLE);
    const width = shape === TableShape.BAR ? 4 : 2;
    const height = 2;
    let positionX = dto.positionX;
    let positionY = dto.positionY;
    if ((positionX === undefined) !== (positionY === undefined)) throw new BadRequestException('Both floor position coordinates must be provided together');
    const occupied = new Set(existing.flatMap((table) => occupiedSlots(table.positionX, table.positionY, table.width, table.height)));
    const floorRows = Math.max(8, ...existing.map((table) => table.positionY + table.height), 0);
    const fits = (x: number, y: number) => x >= 0 && y >= 0 && x + width <= 12 && occupiedSlots(x, y, width, height).every((slot) => !occupied.has(slot));
    if (positionX === undefined || positionY === undefined) {
      let found = false;
      for (let y = 0; !found && y < floorRows; y += 1) {
        for (let x = 0; x <= 12 - width; x += 1) {
          if (fits(x, y)) {
            positionX = x;
            positionY = y;
            found = true;
            break;
          }
        }
      }
    }
    if (positionX === undefined || positionY === undefined || positionX < 0 || positionY < 0 || positionX + width > 12) {
      throw new BadRequestException('That shape does not fit inside the floor');
    }
    if (!fits(positionX, positionY)) {
      const top = [...existing].sort((left, right) => left.positionY - right.positionY || left.positionX - right.positionX)[0];
      positionX = Math.max(0, Math.min(top?.positionX ?? 0, 12 - width));
      positionY = Math.max(0, top?.positionY ?? 0);
    }
    try { return await this.prisma.table.create({ data: {
      tableNumber: dto.tableNumber,
      capacity: dto.capacity,
      status: dto.status ?? TableStatus.AVAILABLE,
      shape,
      positionX,
      positionY,
      width,
      height,
      sectionId,
    } }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Table number already exists'); throw error; }
  }
  async update(id: string, dto: UpdateTableDto) {
    await this.findOne(id);
    try { return await this.prisma.table.update({ where: { id }, data: dto }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Table number already exists'); throw error; }
  }
  async updateStatus(id: string, dto: UpdateTableStatusDto) {
    await this.findOne(id);
    const activeOrderWhere = { tableId: id, status: { in: [OrderStatus.PENDING, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.SERVED] } };
    const activeOrders = await this.prisma.order.count({ where: activeOrderWhere });
    return this.prisma.table.update({
      where: { id },
      data: { status: activeOrders > 0 ? TableStatus.OCCUPIED : dto.status },
      include: { assignedRoomStays: { include: { room: true, occupants: true } } },
    });
  }
  async assignRooms(id: string, roomStayIds: string[]) {
    await this.findOne(id);
    const { table, orderIds } = await this.prisma.$transaction(async (tx) => {
      if (roomStayIds.length) {
        const lockedStays = await tx.roomStay.updateMany({ where: { id: { in: roomStayIds }, checkedOutAt: null }, data: { checkedOutAt: null } });
        if (lockedStays.count !== roomStayIds.length) throw new ConflictException('Choose only active guest stays to assign to the table');
      }
      const table = await tx.table.update({
        where: { id },
        data: { assignedRoomStays: { set: roomStayIds.map((stayId) => ({ id: stayId })) } },
        include: { assignedRoomStays: { include: { room: true, occupants: true } } },
      });
      const ticket = { tableId: id, tableSplitId: null, paymentStatus: OrderPaymentStatus.UNPAID, status: { in: openStatuses } };
      const orderIds = roomStayIds.length === 1 || roomStayIds.length === 0
        ? (await tx.order.findMany({ where: ticket, select: { id: true } })).map((order) => order.id)
        : [];
      if (orderIds.length) await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { roomStayId: roomStayIds.length === 1 ? roomStayIds[0] : null } });
      return { table, orderIds };
    });
    if (orderIds.length) await this.orders.publishUpdates(orderIds);
    return table;
  }
  async updateLayout(dto: UpdateTableLayoutDto) {
    const current = await this.prisma.table.findMany({ select: { id: true } });
    const currentIds = new Set(current.map((table) => table.id));
    const submittedIds = new Set(dto.tables.map((table) => table.id));
    if (dto.tables.length !== current.length || submittedIds.size !== dto.tables.length || dto.tables.some((table) => !currentIds.has(table.id))) {
      throw new BadRequestException('Layout must include every existing table exactly once');
    }
    for (const table of dto.tables) {
      const span = tableSpan(table);
      if (table.positionX < 0 || table.positionY < 0 || table.positionX + span.columns > 12) throw new BadRequestException('A table shape extends beyond the floor boundary');
    }
    return this.prisma.$transaction(async (tx) => {
      await Promise.all(dto.tables.map((table) => tx.table.update({
        where: { id: table.id },
        data: { positionX: table.positionX, positionY: table.positionY, width: table.width, height: table.height, shape: table.shape },
      })));
      return tx.table.findMany({ include: { assignedRoomStays: { include: { room: true, occupants: true } } }, orderBy: [{ positionY: 'asc' }, { positionX: 'asc' }] });
    });
  }
  async checkout(id: string, cashierId: string, dto: CheckoutTableDto) {
    if (dto.paymentMethod === OrderPaymentMethod.CARD) throw new BadRequestException('Use the room folio settlement flow to record a card payment');
    if (dto.paymentMethod !== OrderPaymentMethod.CASH) throw new BadRequestException('Use the signed per-payer settlement flow for room folio or PromptPay payments');
    if (dto.paymentMethod === OrderPaymentMethod.CASH && dto.roomStayId) {
      throw new ConflictException('A room can only be selected when charging to the room folio');
    }
    return this.prisma.$transaction(async (tx) => {
      const table = await tx.table.findUnique({ where: { id }, include: { assignedRoomStays: { include: { room: true, occupants: true } } } });
      if (!table) throw new NotFoundException('Table not found');
      const assignedRoomStayIds = table.assignedRoomStays.map((stay) => stay.id);
      const roomStayId = dto.roomStayId ?? (assignedRoomStayIds.length === 1 ? assignedRoomStayIds[0] : null);
      if (dto.roomStayId && !assignedRoomStayIds.includes(dto.roomStayId)) throw new ConflictException('Choose a guest room assigned to this table');
      if (dto.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && !roomStayId) {
        throw new ConflictException(assignedRoomStayIds.length ? 'Choose which assigned guest room should receive this table bill' : 'Assign a guest room to this table before charging its bill to the room folio');
      }
      const orders = await tx.order.findMany({
        where: { tableId: id, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } },
        include: { items: { include: { menuItem: true } } },
        orderBy: { createdAt: 'asc' },
      });
      if (!orders.length) throw new ConflictException('This table has no open orders to check out');
      if (orders.some((order) => order.status !== OrderStatus.SERVED)) {
        throw new ConflictException('All table orders must be served before checkout');
      }

      let stay: { id: string; room: { roomNumber: string } | null; cashOnly: boolean; chargeLimit: Prisma.Decimal | null; charges: { amount: Prisma.Decimal }[] } | null = null;
      if (dto.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && roomStayId) {
        const active = await tx.roomStay.updateMany({ where: { id: roomStayId, checkedOutAt: null }, data: { checkedOutAt: null } });
        if (!active.count) throw new ConflictException('The selected guest stay is no longer active');
        stay = await tx.roomStay.findUnique({ where: { id: roomStayId }, select: { id: true, cashOnly: true, chargeLimit: true, charges: { where: { settledAt: null, kind: { not: 'ROOM_FEE' } }, select: { amount: true } }, room: { select: { roomNumber: true } } } });
        if (!stay) throw new NotFoundException('Room stay not found');
        if (stay.cashOnly) throw new ConflictException('This guest stay is set to cash only');
      }

      const now = new Date();
      const receiptStays = dto.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT
        ? table.assignedRoomStays.filter((assignedStay) => assignedStay.id === roomStayId)
        : table.assignedRoomStays;
      const roomGuestsSnapshot = receiptStays.map((assignedStay) => ({
        roomNumber: assignedStay.room?.roomNumber ?? 'Unassigned',
        guestName: assignedStay.primaryGuestName,
        guestNames: [...new Set([assignedStay.primaryGuestName, ...assignedStay.occupants.map((occupant) => occupant.name)])],
      }));
      const totalAmount = moneyRound(orders.reduce((sum, order) => sum + Number(order.totalAmount), 0));
      if (stay?.chargeLimit !== null && stay?.chargeLimit !== undefined) {
        const currentFolio = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
        if (currentFolio + totalAmount > Number(stay.chargeLimit)) throw new ConflictException('This guest stay charge limit would be exceeded');
      }
      for (const order of orders) {
        const food = moneyRound(Number(order.totalAmount));
        if (dto.paymentMethod === OrderPaymentMethod.CASH) {
          if (order.paymentStatus === OrderPaymentStatus.ROOM_FOLIO) {
            throw new ConflictException('An order already charged to a room folio cannot be paid in cash again');
          }
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.COMPLETED, paymentMethod: OrderPaymentMethod.CASH, paymentStatus: OrderPaymentStatus.PAID, paidAt: order.paidAt ?? now, paidById: cashierId, ...(table.assignedRoomStays.length === 1 ? { roomStayId: table.assignedRoomStays[0].id } : {}), roomGuestsSnapshot: roomGuestsSnapshot as Prisma.InputJsonValue },
          });
        } else {
          if (order.paymentStatus === OrderPaymentStatus.PAID) {
            throw new ConflictException('An order already paid in cash cannot be charged to a room folio');
          }
          if (order.roomStayId && order.roomStayId !== roomStayId) {
            throw new ConflictException('The table includes an order already linked to another guest room');
          }
          if (order.paymentStatus === OrderPaymentStatus.UNPAID) {
            const activeLines = order.items.filter((line) => !line.removedAt);
            const summary = activeLines.map((line) => `${line.quantity}× ${dishName(line)}`).join(', ');
            await tx.roomCharge.create({
              data: { stayId: roomStayId!, orderId: order.id, kind: 'RESTAURANT_ORDER', description: `Table ${table.tableNumber} restaurant order: ${summary || 'removed dishes'}`, quantity: 1, unitPrice: food, amount: food },
            });
          }
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.COMPLETED, paymentMethod: OrderPaymentMethod.ROOM_CHECKOUT, paymentStatus: OrderPaymentStatus.ROOM_FOLIO, roomStayId, roomGuestsSnapshot: roomGuestsSnapshot as Prisma.InputJsonValue },
          });
        }
      }
      await tx.table.update({ where: { id }, data: { status: TableStatus.AVAILABLE, assignedRoomStays: { set: [] } } });
      await tx.tableSplit.deleteMany({ where: { tableId: id } });
      return { tableId: id, tableNumber: table.tableNumber, paymentMethod: dto.paymentMethod, room: stay?.room ?? null, totalAmount, orderIds: orders.map((order) => order.id), checkedOutAt: now };
    });
  }
  async assignBillPayer(id: string, orderIds: string[], roomStayId: string | null) {
    const uniqueIds = [...new Set(orderIds)];
    return this.prisma.$transaction(async (tx) => {
      const table = await tx.table.findUnique({ where: { id }, select: { id: true, assignedRoomStays: { select: { id: true } } } });
      if (!table) throw new NotFoundException('Table not found');
      const orders = await tx.order.findMany({ where: { id: { in: uniqueIds }, tableId: id, paymentStatus: OrderPaymentStatus.UNPAID, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } }, select: { id: true } });
      if (orders.length !== uniqueIds.length) throw new ConflictException('Choose open unpaid orders on this table');
      if (roomStayId) {
        const stay = await tx.roomStay.findUnique({ where: { id: roomStayId }, select: { id: true, checkedOutAt: true } });
        if (!stay || stay.checkedOutAt) throw new ConflictException('Choose a guest who is still checked in');
        const assigned = new Set(table.assignedRoomStays.map((entry) => entry.id));
        assigned.add(roomStayId);
        await tx.table.update({ where: { id }, data: { assignedRoomStays: { set: [...assigned].map((stayId) => ({ id: stayId })) } } });
      }
      await tx.order.updateMany({ where: { id: { in: uniqueIds } }, data: { roomStayId } });
      return { orderIds: uniqueIds, roomStayId };
    });
  }

  async settleParty(id: string, cashierId: string, dto: SettlePartyDto) {
    const folio = dto.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT;
    const signedByName = dto.signedByName?.trim() || null;
    const signatureData = dto.signatureData?.trim() || null;
    if (folio && Boolean(signedByName) !== Boolean(signatureData)) throw new BadRequestException('A guest name and signature go together');
    if (![OrderPaymentMethod.CASH, OrderPaymentMethod.CARD, OrderPaymentMethod.PROMPTPAY, OrderPaymentMethod.ROOM_CHECKOUT].includes(dto.paymentMethod)) throw new BadRequestException('Choose cash, card, PromptPay QR, or a room tab');
    try {
    return await this.prisma.$transaction(async (tx) => {
      const prior = await this.idempotency.read(tx, 'table.settle', dto.clientRequestId);
      if (prior) return prior;
      const table = await tx.table.findUnique({ where: { id }, include: { assignedRoomStays: { include: { room: true, occupants: true } } } });
      if (!table) throw new NotFoundException('Table not found');
      const orders = await tx.order.findMany({ where: { id: { in: [...new Set(dto.orderIds)] }, tableId: id }, include: { items: { include: { menuItem: true } } } });
      if (orders.length !== new Set(dto.orderIds).size) throw new ConflictException('One or more selected orders do not belong to this table');
      if (orders.some((order) => order.paymentStatus !== OrderPaymentStatus.UNPAID || order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED)) throw new ConflictException('Selected orders must still be open and unsettled');
      const bills = await tx.tableBill.findMany({ where: { tableId: id }, select: { lines: true } });
      if (bills.some((bill) => (Array.isArray(bill.lines) ? bill.lines as { orderId?: string }[] : []).some((line) => dto.orderIds.includes(line.orderId ?? '')))) {
        throw new ConflictException('This table is split into bills. Settle each bill on its own.');
      }
      const linkedStayIds = [...new Set(orders.map((order) => order.roomStayId).filter((stayId): stayId is string => Boolean(stayId)))];
      if (!dto.roomStayId && linkedStayIds.length > 1) throw new ConflictException('Settle orders for one payer at a time');
      const payerStayId = dto.roomStayId ?? linkedStayIds[0] ?? (table.assignedRoomStays.length === 1 ? table.assignedRoomStays[0].id : null);
      const now = new Date();
      let stay: { id: string; checkedOutAt: Date | null; cashOnly: boolean; chargeLimit: Prisma.Decimal | null; charges: { amount: Prisma.Decimal }[]; room: { roomNumber: string } | null } | null = null;
      if (folio) {
        if (!payerStayId) throw new ConflictException('Choose a guest room');
        if (!table.assignedRoomStays.some((entry) => entry.id === payerStayId)) {
          await tx.table.update({ where: { id }, data: { assignedRoomStays: { connect: { id: payerStayId } } } });
        }
        stay = await tx.roomStay.findUnique({ where: { id: payerStayId }, select: { id: true, checkedOutAt: true, cashOnly: true, chargeLimit: true, charges: { where: { settledAt: null, kind: { not: 'ROOM_FEE' } }, select: { amount: true } }, room: { select: { roomNumber: true } } } });
        if (!stay || stay.checkedOutAt) throw new ConflictException('Choose a guest who is still checked in');
        if (stay.cashOnly) throw new ConflictException('This guest stay is set to cash only');
        const foodTotal = moneyRound(orders.reduce((sum, order) => sum + Number(order.totalAmount), 0));
        const currentFolio = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
        if (stay.chargeLimit !== null && currentFolio + foodTotal > Number(stay.chargeLimit)) throw new ConflictException('This guest stay charge limit would be exceeded');
      }
      let snapshotStays = table.assignedRoomStays;
      if (payerStayId) {
        const known = table.assignedRoomStays.find((entry) => entry.id === payerStayId);
        if (known) snapshotStays = [known];
        else {
          const loaded = await tx.roomStay.findUnique({ where: { id: payerStayId }, include: { room: true, occupants: true } });
          snapshotStays = loaded ? [loaded] : [];
        }
      }
      const roomGuestsSnapshot = snapshotStays.map(guestSnapshot);
      const foodTotal = moneyRound(orders.reduce((sum, order) => sum + Number(order.totalAmount), 0));
      for (const order of orders) {
        const food = moneyRound(Number(order.totalAmount));
        if (folio) {
          const activeLines = order.items.filter((line) => !line.removedAt);
          const summary = activeLines.map((line) => `${line.quantity}× ${dishName(line)}`).join(', ');
          await tx.roomCharge.create({ data: { stayId: payerStayId!, orderId: order.id, kind: 'RESTAURANT_ORDER', description: `Table ${table.tableNumber} restaurant order: ${summary || 'removed dishes'}`, quantity: 1, unitPrice: food, amount: food, signedByName, signatureData } });
        }
        await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.COMPLETED, paymentMethod: dto.paymentMethod, paymentStatus: folio ? OrderPaymentStatus.ROOM_FOLIO : OrderPaymentStatus.PAID, ...(folio ? {} : { paidAt: now, paidById: cashierId }), ...(payerStayId ? { roomStayId: payerStayId } : {}), roomGuestsSnapshot: roomGuestsSnapshot as Prisma.InputJsonValue } });
        await tx.orderPrepTicket.updateMany({ where: { orderId: order.id, status: { in: [PrepTicketStatus.PENDING, PrepTicketStatus.PREPARING] } }, data: { status: PrepTicketStatus.READY, preparingAt: now, readyAt: now } });
      }
      const remaining = await tx.order.count({ where: { tableId: id, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } } });
      if (remaining === 0) {
        await tx.table.update({ where: { id }, data: { status: TableStatus.AVAILABLE, assignedRoomStays: { set: [] } } });
        await tx.tableSplit.deleteMany({ where: { tableId: id } });
      }
      const settled = { tableId: id, tableNumber: table.tableNumber, paymentMethod: dto.paymentMethod, room: stay?.room ?? null, orderIds: orders.map((order) => order.id), totalAmount: foodTotal, signedByName: folio ? signedByName : null, checkedOutAt: now, tableCleared: remaining === 0 };
      await this.idempotency.write(tx, 'table.settle', dto.clientRequestId, cashierId, settled);
      return settled;
    });
    } catch (error) {
      const saved = await this.idempotency.recover(error, 'table.settle', dto.clientRequestId);
      if (saved) return saved;
      throw error;
    }
  }
  async moveParty(id: string, destinationId: string) {
    if (id === destinationId) throw new BadRequestException('Choose a different table');
    const movedIds = await this.prisma.$transaction(async (tx) => {
      const source = await tx.table.findUnique({ where: { id }, include: { assignedRoomStays: { select: { id: true } } } });
      const destination = await tx.table.findUnique({ where: { id: destinationId } });
      if (!source || !destination) throw new NotFoundException('Table not found');
      const openWhere = { status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } };
      if (await tx.order.count({ where: { tableId: destinationId, ...openWhere } })) throw new ConflictException('That table already has an open order');
      if (await tx.tableBill.count({ where: { tableId: destinationId, status: 'OPEN' } })) throw new ConflictException('That table already has an open bill');
      const moving = await tx.order.findMany({ where: { tableId: id, ...openWhere }, select: { id: true, tableSplitId: true } });
      const orderIds = moving.map((order) => order.id);
      await tx.tableSplit.deleteMany({ where: { tableId: destinationId } });
      const splits = await tx.tableSplit.findMany({ where: { tableId: id } });
      if (splits.length) await tx.tableSplit.updateMany({ where: { tableId: id }, data: { tableId: destinationId } });
      if (orderIds.length) {
        for (const order of moving) {
          const label = splits.find((split) => split.id === order.tableSplitId)?.label ?? '';
          await tx.order.update({ where: { id: order.id }, data: { tableId: destinationId, tableSnapshot: { tableNumber: `${destination.tableNumber}${label}` } } });
        }
        const charges = await tx.roomCharge.findMany({ where: { orderId: { in: orderIds }, settledAt: null }, select: { id: true, description: true } });
        const from = `Table ${source.tableNumber}`;
        const to = `Table ${destination.tableNumber}`;
        for (const charge of charges) {
          if (!charge.description.startsWith(from) || /^\d/.test(charge.description.slice(from.length))) continue;
          await tx.roomCharge.update({ where: { id: charge.id }, data: { description: `${to}${charge.description.slice(from.length)}` } });
        }
      }
      await tx.tableBill.updateMany({ where: { tableId: id, status: 'OPEN' }, data: { tableId: destinationId } });
      const stayIds = source.assignedRoomStays.map((stay) => stay.id);
      if (stayIds.length) {
        await tx.table.update({ where: { id }, data: { assignedRoomStays: { set: [] } } });
        await tx.table.update({ where: { id: destinationId }, data: { assignedRoomStays: { connect: stayIds.map((stayId) => ({ id: stayId })) } } });
      }
      const sourceStillOpen = await tx.order.count({ where: { tableId: id, ...openWhere } });
      await tx.table.update({ where: { id }, data: { status: sourceStillOpen ? TableStatus.OCCUPIED : TableStatus.AVAILABLE } });
      if (orderIds.length) await tx.table.update({ where: { id: destinationId }, data: { status: TableStatus.OCCUPIED } });
      return orderIds;
    });
    const [orders, tables] = await Promise.all([
      this.orders.publishUpdates(movedIds),
      this.prisma.table.findMany({ where: { id: { in: [id, destinationId] } }, include: this.tableView() }),
    ]);
    return { tables, orders };
  }

  async addSplit(id: string) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const movedIds = await this.prisma.$transaction(async (tx) => {
      const table = await tx.table.findUnique({ where: { id }, include: { splits: { orderBy: { position: 'asc' } }, assignedRoomStays: { select: { id: true } } } });
      if (!table) throw new NotFoundException('Table not found');
      const used = new Set(table.splits.map((split) => split.label));
      const fresh = letters.split('').filter((letter) => !used.has(letter));
      if (!fresh.length) throw new BadRequestException('This table already has every side');
      const moved: string[] = [];
      if (!table.splits.length) {
        const roomStayId = table.assignedRoomStays.length === 1 ? table.assignedRoomStays[0].id : null;
        const first = await tx.tableSplit.create({ data: { tableId: id, label: fresh[0], position: 0, roomStayId } });
        await tx.tableSplit.create({ data: { tableId: id, label: fresh[1] ?? 'B', position: 1 } });
        const open = await tx.order.findMany({ where: { tableId: id, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } }, select: { id: true } });
        if (open.length) {
          await tx.order.updateMany({ where: { id: { in: open.map((order) => order.id) } }, data: { tableSplitId: first.id, tableSnapshot: { tableNumber: `${table.tableNumber}${first.label}` } } });
          moved.push(...open.map((order) => order.id));
        }
      } else {
        await tx.tableSplit.create({ data: { tableId: id, label: fresh[0], position: table.splits.length } });
      }
      return moved;
    });
    const [orders, table] = await Promise.all([this.orders.publishUpdates(movedIds), this.shownTable(id)]);
    return { table, orders };
  }

  async setSplitRoom(id: string, splitId: string, roomStayId: string | null) {
    const table = await this.prisma.$transaction(async (tx) => {
      const split = await tx.tableSplit.findFirst({ where: { id: splitId, tableId: id } });
      if (!split) throw new NotFoundException('That side of the table was not found');
      if (roomStayId) {
        const active = await tx.roomStay.updateMany({ where: { id: roomStayId, checkedOutAt: null }, data: { checkedOutAt: null } });
        if (!active.count) throw new ConflictException('Choose a guest who is still checked in');
      }
      await tx.tableSplit.update({ where: { id: splitId }, data: { roomStayId } });
      const ticket = { tableId: id, tableSplitId: splitId, paymentStatus: OrderPaymentStatus.UNPAID, status: { in: openStatuses } };
      const orderIds = (await tx.order.findMany({ where: ticket, select: { id: true } })).map((order) => order.id);
      if (orderIds.length) await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { roomStayId } });
      const splits = await tx.tableSplit.findMany({ where: { tableId: id }, select: { roomStayId: true } });
      const stayIds = [...new Set(splits.flatMap((entry) => entry.roomStayId ? [entry.roomStayId] : []))];
      const table = await tx.table.update({ where: { id }, data: { assignedRoomStays: { set: stayIds.map((stayId) => ({ id: stayId })) } }, include: this.tableView() });
      return { table, orderIds };
    });
    if (table.orderIds.length) await this.orders.publishUpdates(table.orderIds);
    return { table: table.table };
  }

  async removeSplit(id: string, splitId: string) {
    await this.prisma.$transaction(async (tx) => {
      const split = await tx.tableSplit.findFirst({ where: { id: splitId, tableId: id } });
      if (!split) throw new NotFoundException('That side of the table was not found');
      const open = await tx.order.count({ where: { tableId: id, tableSplitId: splitId, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } } });
      if (open) throw new ConflictException('This side still has an order');
      const remaining = await tx.tableSplit.findMany({ where: { tableId: id, NOT: { id: splitId } }, select: { roomStayId: true } });
      await tx.tableSplit.delete({ where: { id: splitId } });
      const stayIds = remaining.length
        ? [...new Set(remaining.flatMap((entry) => entry.roomStayId ? [entry.roomStayId] : []))]
        : (split.roomStayId ? [split.roomStayId] : []);
      await tx.table.update({ where: { id }, data: { assignedRoomStays: { set: stayIds.map((stayId) => ({ id: stayId })) } } });
    });
    return { table: await this.shownTable(id), orders: [] };
  }

  async remove(id: string) {
    const table = await this.findOne(id);
    const open = await this.prisma.order.count({ where: { tableId: id, status: { in: [OrderStatus.PENDING, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.SERVED] } } });
    if (open) throw new ConflictException('Finish the open order on this table first. Past orders keep the table name.');
    await this.prisma.$transaction(async (tx) => {
      await tx.order.updateMany({ where: { tableId: id }, data: { tableSnapshot: { tableNumber: table.tableNumber } } });
      await tx.table.delete({ where: { id } });
    });
    return { id };
  }

  async listBills(id: string, splitId?: string) {
    await this.findOne(id);
    if (splitId && !await this.prisma.tableSplit.findFirst({ where: { id: splitId, tableId: id }, select: { id: true } })) throw new NotFoundException('That side of the table was not found');
    const orders = await this.prisma.order.findMany({
      where: { tableId: id, paymentStatus: OrderPaymentStatus.UNPAID, status: { in: openStatuses }, ...(splitId ? { tableSplitId: splitId } : {}) },
      include: { items: { include: { menuItem: true } } },
    });
    const units = unitsFor(orders);
    const stored = await this.prisma.tableBill.findMany({ where: { tableId: id }, orderBy: { number: 'asc' } });
    const unitKeys = new Set(units.map((unit) => unit.key));
    const relevant = stored.filter((bill) => asLines(bill.lines).some((line) => unitKeys.has(`${line.orderItemId}:${line.unit}`)));
    const settledKeys = new Set(relevant.filter((bill) => bill.status === 'SETTLED').flatMap((bill) => asLines(bill.lines).map((line) => `${line.orderItemId}:${line.unit}`)));
    return { units: units.filter((unit) => !settledKeys.has(unit.key)), bills: await this.presentBills(relevant) };
  }

  async saveBillSplit(id: string, dto: SaveBillSplitDto) {
    await this.findOne(id);
    await this.prisma.$transaction(async (tx) => {
      const setting = await tx.restaurantSetting.findUnique({ where: { id: 'restaurant' }, select: { vatPercent: true } });
      const vatPercent = Number(setting?.vatPercent ?? 0);
      if (dto.splitId && !await tx.tableSplit.findFirst({ where: { id: dto.splitId, tableId: id }, select: { id: true } })) throw new NotFoundException('That side of the table was not found');
      const orders = await tx.order.findMany({
        where: { tableId: id, paymentStatus: OrderPaymentStatus.UNPAID, status: { in: openStatuses }, ...(dto.splitId ? { tableSplitId: dto.splitId } : {}) },
        include: { items: { include: { menuItem: true } } },
      });
      const units = unitsFor(orders);
      const settled = await tx.tableBill.findMany({ where: { tableId: id, status: 'SETTLED' } });
      const currentKeys = new Set(units.map((unit) => unit.key));
      const blocking = settled.filter((bill) => asLines(bill.lines).some((line) => currentKeys.has(`${line.orderItemId}:${line.unit}`)));
      const settledKeys = new Set(blocking.flatMap((bill) => asLines(bill.lines).map((line) => `${line.orderItemId}:${line.unit}`)));
      const remaining = new Map(units.filter((unit) => !settledKeys.has(unit.key)).map((unit) => [unit.key, unit]));
      const seen = new Set<string>();
      const next: Prisma.TableBillUncheckedCreateInput[] = [];
      for (const entry of dto.bills) {
        if (entry.number < 1) throw new BadRequestException('Each bill needs a number');
        if (blocking.some((bill) => bill.number === entry.number)) throw new ConflictException('That bill is already settled');
        const lines: BillLine[] = [];
        for (const source of entry.lines) {
          const key = `${source.orderItemId}:${source.unit}`;
          const match = remaining.get(key);
          if (!match || seen.has(key)) throw new ConflictException('Each dish can be on only one open bill');
          seen.add(key);
          lines.push({ orderId: match.orderId, orderItemId: match.orderItemId, unit: match.unit, name: match.name, detail: match.detail, amount: match.amount });
        }
        if (!lines.length) continue;
        const amount = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
        next.push({ tableId: id, number: entry.number, status: 'OPEN', amount, vatPercent, lines: lines as unknown as Prisma.InputJsonValue });
      }
      if (seen.size !== remaining.size) throw new ConflictException('Every dish still needs a bill');
      const scopeKeys = new Set(units.map((unit) => unit.key));
      const openBills = await tx.tableBill.findMany({ where: { tableId: id, status: 'OPEN' } });
      const touched = openBills.filter((bill) => asLines(bill.lines).some((line) => scopeKeys.has(`${line.orderItemId}:${line.unit}`)));
      if (touched.length) await tx.tableBill.deleteMany({ where: { id: { in: touched.map((bill) => bill.id) } } });
      for (const bill of touched) {
        const keep = asLines(bill.lines).filter((line) => !scopeKeys.has(`${line.orderItemId}:${line.unit}`));
        if (!keep.length) continue;
        const amount = Math.round(keep.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
        await tx.tableBill.create({ data: { tableId: id, number: bill.number, status: 'OPEN', amount, vatPercent: Number(bill.vatPercent ?? vatPercent), lines: keep as unknown as Prisma.InputJsonValue } });
      }
      for (const row of next) await tx.tableBill.create({ data: row });
    });
    return this.listBills(id, dto.splitId);
  }

  async settleBill(id: string, billId: string, cashierId: string, dto: SettleBillDto) {
    const folio = dto.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT;
    const signedByName = dto.signedByName?.trim() || null;
    const signatureData = dto.signatureData?.trim() || null;
    if (![OrderPaymentMethod.CASH, OrderPaymentMethod.CARD, OrderPaymentMethod.PROMPTPAY, OrderPaymentMethod.ROOM_CHECKOUT].includes(dto.paymentMethod)) throw new BadRequestException('Choose cash, card, PromptPay QR, or a room tab');
    if (folio && Boolean(signedByName) !== Boolean(signatureData)) throw new BadRequestException('A guest name and signature go together');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const prior = await this.idempotency.read(tx, 'table.bill', dto.clientRequestId);
        if (prior) return prior;
        const table = await tx.table.findUnique({ where: { id }, include: { assignedRoomStays: { select: { id: true } } } });
        if (!table) throw new NotFoundException('Table not found');
        const bill = await tx.tableBill.findFirst({ where: { id: billId, tableId: id } });
        if (!bill) throw new NotFoundException('Bill not found');
        if (bill.status !== 'OPEN') throw new ConflictException('This bill is already settled');
        const orders = await tx.order.findMany({
          where: { tableId: id, paymentStatus: OrderPaymentStatus.UNPAID, status: { in: openStatuses } },
          include: { items: { include: { menuItem: true } } },
        });
        const fresh = new Map(unitsFor(orders).map((unit) => [unit.key, unit]));
        const lines = asLines(bill.lines).map((line) => {
          const match = fresh.get(`${line.orderItemId}:${line.unit}`);
          if (!match) throw new ConflictException('A dish on this bill is no longer open');
          return match;
        });
        const amount = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
        if (amount <= 0) throw new BadRequestException('This bill has nothing to settle');
        const now = new Date();
        let room: { roomNumber: string; guestName: string; guestNames: string[] } | null = null;
        let chargeId: string | null = null;
        if (folio) {
          if (!dto.roomStayId) throw new ConflictException('Choose a guest room');
          const stay = await tx.roomStay.findUnique({ where: { id: dto.roomStayId }, include: { room: true, occupants: true, charges: { where: { settledAt: null, kind: { not: 'ROOM_FEE' } }, select: { amount: true } } } });
          if (!stay || stay.checkedOutAt) throw new ConflictException('Choose a guest who is still checked in');
          if (stay.cashOnly) throw new ConflictException('This guest stay is set to cash only');
          const open = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
          if (stay.chargeLimit !== null && open + amount > Number(stay.chargeLimit)) throw new ConflictException('This guest stay charge limit would be exceeded');
          if (!table.assignedRoomStays.some((entry) => entry.id === stay.id)) {
            await tx.table.update({ where: { id }, data: { assignedRoomStays: { connect: { id: stay.id } } } });
          }
          const guestNames = [...new Set([stay.primaryGuestName, ...stay.occupants.map((person) => person.name)].filter(Boolean))];
          room = { roomNumber: stay.room?.roomNumber ?? 'Unassigned', guestName: stay.primaryGuestName, guestNames };
          const existingCharge = await tx.roomCharge.findUnique({ where: { orderId: lines[0]?.orderId ?? '' } });
          const charge = await tx.roomCharge.create({
            data: {
              stayId: stay.id,
              orderId: existingCharge ? null : lines[0]?.orderId ?? null,
              kind: 'RESTAURANT_ORDER',
              description: `Table ${table.tableNumber} · Bill ${bill.number}`,
              quantity: 1,
              unitPrice: amount,
              amount,
              signedByName,
              signatureData,
              billId: bill.id,
              billNumber: bill.number,
              lines: lines as unknown as Prisma.InputJsonValue,
            },
          });
          chargeId = charge.id;
        }
        const rememberedStayId = dto.roomStayId ?? (table.assignedRoomStays.length === 1 ? table.assignedRoomStays[0].id : null);
        const saved = await tx.tableBill.update({
          where: { id: bill.id },
          data: { status: 'SETTLED', method: dto.paymentMethod, stayId: rememberedStayId, amount, signedByName: folio ? signedByName : null, signatureData: folio ? signatureData : null, paidAt: now, chargeId, lines: lines as unknown as Prisma.InputJsonValue },
        });
        const orderIds = [...new Set(lines.map((line) => line.orderId))];
        for (const orderId of orderIds) await this.finishSplitOrder(tx, orderId, cashierId, now);
        const remaining = await tx.order.count({ where: { tableId: id, status: { in: openStatuses } } });
        if (remaining === 0) {
          await tx.table.update({ where: { id }, data: { status: TableStatus.AVAILABLE, assignedRoomStays: { set: [] } } });
          await tx.tableSplit.deleteMany({ where: { tableId: id } });
        }
        const result = { bill: (await this.presentBills([saved]))[0], tableNumber: table.tableNumber, room, tableCleared: remaining === 0, checkedOutAt: now };
        await this.idempotency.write(tx, 'table.bill', dto.clientRequestId, cashierId, result);
        return result;
      });
    } catch (error) {
      const saved = await this.idempotency.recover(error, 'table.bill', dto.clientRequestId);
      if (saved) return saved;
      throw error;
    }
  }

  private async finishSplitOrder(tx: Prisma.TransactionClient, orderId: string, cashierId: string, now: Date) {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { menuItem: true } } } });
    if (!order || order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED) return;
    const units = unitsFor([order]);
    const settled = await tx.tableBill.findMany({ where: { status: 'SETTLED', ...(order.tableId ? { tableId: order.tableId } : {}) } });
    const mine = settled.filter((bill) => asLines(bill.lines).some((line) => line.orderId === orderId));
    const covered = new Set(mine.flatMap((bill) => asLines(bill.lines).filter((line) => line.orderId === orderId).map((line) => `${line.orderItemId}:${line.unit}`)));
    if (!units.length || units.some((unit) => !covered.has(unit.key))) return;
    const methods = [...new Set(mine.map((bill) => bill.method).filter((method): method is string => Boolean(method)))];
    const folio = methods.length === 1 && methods[0] === OrderPaymentMethod.ROOM_CHECKOUT;
    const stayIds = [...new Set(mine.map((bill) => bill.stayId).filter((stayId): stayId is string => Boolean(stayId)))];
    let stays = stayIds.length ? await tx.roomStay.findMany({ where: { id: { in: stayIds } }, include: { room: true, occupants: true } }) : [];
    if (!stays.length && order.tableId) {
      const seated = await tx.table.findUnique({ where: { id: order.tableId }, include: { assignedRoomStays: { include: { room: true, occupants: true } } } });
      stays = seated?.assignedRoomStays ?? [];
    }
    const roomStayId = stays.length === 1 ? stays[0].id : order.roomStayId;
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.COMPLETED,
        paymentMethod: methods.length === 1 ? methods[0] as OrderPaymentMethod : OrderPaymentMethod.CASH,
        paymentStatus: folio ? OrderPaymentStatus.ROOM_FOLIO : OrderPaymentStatus.PAID,
        ...(folio ? {} : { paidAt: now, paidById: cashierId }),
        ...(roomStayId ? { roomStayId } : {}),
        ...(stays.length ? { roomGuestsSnapshot: stays.map(guestSnapshot) as Prisma.InputJsonValue } : {}),
      },
    });
    await tx.orderPrepTicket.updateMany({ where: { orderId, status: { in: [PrepTicketStatus.PENDING, PrepTicketStatus.PREPARING] } }, data: { status: PrepTicketStatus.READY, preparingAt: now, readyAt: now } });
  }

  private async presentBills(bills: { id: string; tableId: string; number: number; status: string; method: string | null; stayId: string | null; amount: Prisma.Decimal; vatPercent?: Prisma.Decimal | number | null; signedByName: string | null; signatureData: string | null; paidAt: Date | null; chargeId: string | null; lines: Prisma.JsonValue; createdAt: Date }[]) {
    const stayIds = [...new Set(bills.map((bill) => bill.stayId).filter((stayId): stayId is string => Boolean(stayId)))];
    const stays = stayIds.length ? await this.prisma.roomStay.findMany({ where: { id: { in: stayIds } }, include: { room: true, occupants: true } }) : [];
    return bills.map((bill) => {
      const stay = stays.find((entry) => entry.id === bill.stayId);
      return {
        id: bill.id,
        tableId: bill.tableId,
        number: bill.number,
        status: bill.status,
        method: bill.method,
        stayId: bill.stayId,
        roomNumber: stay?.room?.roomNumber ?? null,
        guestName: stay?.primaryGuestName ?? null,
        guestNames: stay ? [...new Set([stay.primaryGuestName, ...stay.occupants.map((person) => person.name)].filter(Boolean))] : [],
        amount: Number(bill.amount),
        vatPercent: Number(bill.vatPercent ?? 0),
        signedByName: bill.signedByName,
        signatureData: bill.signatureData,
        paidAt: bill.paidAt,
        chargeId: bill.chargeId,
        lines: asLines(bill.lines),
        createdAt: bill.createdAt,
      };
    });
  }
}
