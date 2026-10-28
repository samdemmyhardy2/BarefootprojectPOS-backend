import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { UpdateTableStatusDto } from './dto/update-table-status.dto';
import { CheckoutTableDto } from './dto/checkout-table.dto';
import { OrderPaymentMethod, OrderPaymentStatus, OrderStatus, TableShape, TableStatus } from 'prisma/generated/prisma/enums';
import { UpdateTableLayoutDto } from './dto/update-table-layout.dto';
import { SettlePartyDto } from './dto/settle-party.dto';

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
  constructor(private readonly prisma: PrismaService) {}
  findAll() { return this.prisma.table.findMany({ include: { assignedRoomStays: { include: { room: true, occupants: true } } }, orderBy: { tableNumber: 'asc' } }); }
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
    if (positionX === undefined || positionY === undefined) {
      const occupied = new Set(existing.flatMap((table) => occupiedSlots(table.positionX, table.positionY, table.width, table.height)));
      let found = false;
      for (let y = 0; !found && y < 10_000; y += 1) {
        for (let x = 0; x <= 12 - width; x += 1) {
          if (occupiedSlots(x, y, width, height).every((slot) => !occupied.has(slot))) {
            positionX = x;
            positionY = y;
            found = true;
            break;
          }
        }
      }
      if (!found) throw new ConflictException('No free space remains on the floor layout');
    }
    if (positionX === undefined || positionY === undefined) throw new ConflictException('Could not assign a floor position');
    const occupied = new Set(existing.flatMap((table) => occupiedSlots(table.positionX, table.positionY, table.width, table.height)));
    if (positionX + width > 12 || occupiedSlots(positionX, positionY, width, height).some((slot) => occupied.has(slot))) {
      throw new ConflictException('That shape does not fit at the selected floor position');
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
    return this.prisma.$transaction(async (tx) => {
      if (roomStayIds.length) {
        const lockedStays = await tx.roomStay.updateMany({ where: { id: { in: roomStayIds }, checkedOutAt: null }, data: { checkedOutAt: null } });
        if (lockedStays.count !== roomStayIds.length) throw new ConflictException('Choose only active guest stays to assign to the table');
      }
      return tx.table.update({
        where: { id },
        data: { assignedRoomStays: { set: roomStayIds.map((stayId) => ({ id: stayId })) } },
        include: { assignedRoomStays: { include: { room: true, occupants: true } } },
      });
    });
  }
  async updateLayout(dto: UpdateTableLayoutDto) {
    const current = await this.prisma.table.findMany({ select: { id: true, sectionId: true } });
    const currentIds = new Set(current.map((table) => table.id));
    const sectionById = new Map(current.map((table) => [table.id, table.sectionId]));
    const submittedIds = new Set(dto.tables.map((table) => table.id));
    if (dto.tables.length !== current.length || submittedIds.size !== dto.tables.length || dto.tables.some((table) => !currentIds.has(table.id))) {
      throw new BadRequestException('Layout must include every existing table exactly once');
    }
    const slotsBySection = new Map<string, Set<string>>();
    for (const table of dto.tables) {
      const span = tableSpan(table);
      const tableSlots = occupiedSlots(table.positionX, table.positionY, span.columns, span.rows);
      if (table.positionX + span.columns > 12) throw new BadRequestException('A table shape extends beyond the floor boundary');
      const sectionId = sectionById.get(table.id) ?? '';
      const slots = slotsBySection.get(sectionId) ?? new Set<string>();
      if (tableSlots.some((slot) => slots.has(slot))) throw new BadRequestException('Table shapes cannot overlap on the floor');
      tableSlots.forEach((slot) => slots.add(slot));
      slotsBySection.set(sectionId, slots);
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

      let stay: { id: string; room: { roomNumber: string }; cashOnly: boolean; chargeLimit: Prisma.Decimal | null; charges: { amount: Prisma.Decimal }[] } | null = null;
      if (dto.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && roomStayId) {
        const active = await tx.roomStay.updateMany({ where: { id: roomStayId, checkedOutAt: null }, data: { checkedOutAt: null } });
        if (!active.count) throw new ConflictException('The selected guest stay is no longer active');
        stay = await tx.roomStay.findUnique({ where: { id: roomStayId }, select: { id: true, cashOnly: true, chargeLimit: true, charges: { where: { settledAt: null }, select: { amount: true } }, room: { select: { roomNumber: true } } } });
        if (!stay) throw new NotFoundException('Room stay not found');
        if (stay.cashOnly) throw new ConflictException('This guest stay is set to cash only');
      }

      const now = new Date();
      const receiptStays = dto.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT
        ? table.assignedRoomStays.filter((assignedStay) => assignedStay.id === roomStayId)
        : table.assignedRoomStays;
      const roomGuestsSnapshot = receiptStays.map((assignedStay) => ({
        roomNumber: assignedStay.room.roomNumber,
        guestName: assignedStay.primaryGuestName,
        guestNames: [...new Set([assignedStay.primaryGuestName, ...assignedStay.occupants.map((occupant) => occupant.name)])],
      }));
      const totalAmount = orders.reduce((sum, order) => sum + Number(order.totalAmount), 0);
      if (stay?.chargeLimit !== null && stay?.chargeLimit !== undefined) {
        const currentFolio = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
        if (currentFolio + totalAmount > Number(stay.chargeLimit)) throw new ConflictException('This guest stay charge limit would be exceeded');
      }
      for (const order of orders) {
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
            const summary = order.items.map((line) => `${line.quantity}× ${line.menuItem.name}`).join(', ');
            await tx.roomCharge.create({
              data: { stayId: roomStayId!, orderId: order.id, kind: 'RESTAURANT_ORDER', description: `Table ${table.tableNumber} restaurant order: ${summary}`, quantity: 1, unitPrice: Number(order.totalAmount), amount: Number(order.totalAmount) },
            });
          }
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.COMPLETED, paymentMethod: OrderPaymentMethod.ROOM_CHECKOUT, paymentStatus: OrderPaymentStatus.ROOM_FOLIO, roomStayId, roomGuestsSnapshot: roomGuestsSnapshot as Prisma.InputJsonValue },
          });
        }
      }
      await tx.table.update({ where: { id }, data: { status: TableStatus.AVAILABLE, assignedRoomStays: { set: [] } } });
      return { tableId: id, tableNumber: table.tableNumber, paymentMethod: dto.paymentMethod, room: stay?.room ?? null, totalAmount, orderIds: orders.map((order) => order.id), checkedOutAt: now };
    });
  }
  async settleParty(id: string, cashierId: string, dto: SettlePartyDto) {
    const folio = dto.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT;
    if (folio && (!dto.signedByName?.trim() || !dto.signatureData?.trim())) throw new BadRequestException('A guest name and signature are required to add this bill to a room tab');
    if (![OrderPaymentMethod.CASH, OrderPaymentMethod.CARD, OrderPaymentMethod.PROMPTPAY, OrderPaymentMethod.ROOM_CHECKOUT].includes(dto.paymentMethod)) throw new BadRequestException('Choose cash, card, PromptPay QR, or a room tab');
    return this.prisma.$transaction(async (tx) => {
      const table = await tx.table.findUnique({ where: { id }, include: { assignedRoomStays: { include: { room: true, occupants: true } } } });
      if (!table) throw new NotFoundException('Table not found');
      const orders = await tx.order.findMany({ where: { id: { in: [...new Set(dto.orderIds)] }, tableId: id }, include: { items: { include: { menuItem: true } } } });
      if (orders.length !== new Set(dto.orderIds).size) throw new ConflictException('One or more selected orders do not belong to this table');
      if (orders.some((order) => order.status !== OrderStatus.SERVED || order.paymentStatus !== OrderPaymentStatus.UNPAID)) throw new ConflictException('Selected orders must be served and unsettled');
      const payerStayId = orders[0]?.roomStayId ?? null;
      if (orders.some((order) => (order.roomStayId ?? null) !== payerStayId)) throw new ConflictException('Settle orders for one payer at a time');
      const now = new Date();
      let stay: { id: string; cashOnly: boolean; chargeLimit: Prisma.Decimal | null; charges: { amount: Prisma.Decimal }[]; room: { roomNumber: string } } | null = null;
      if (folio) {
        if (!payerStayId || !table.assignedRoomStays.some((entry) => entry.id === payerStayId)) throw new ConflictException('This payer does not have an active room assigned to this table');
        stay = await tx.roomStay.findUnique({ where: { id: payerStayId }, select: { id: true, cashOnly: true, chargeLimit: true, charges: { where: { settledAt: null }, select: { amount: true } }, room: { select: { roomNumber: true } } } });
        if (!stay) throw new NotFoundException('Room stay not found');
        if (stay.cashOnly) throw new ConflictException('This guest stay is set to cash only');
        const amount = orders.reduce((sum, order) => sum + Number(order.totalAmount), 0);
        const currentFolio = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
        if (stay.chargeLimit !== null && currentFolio + amount > Number(stay.chargeLimit)) throw new ConflictException('This guest stay charge limit would be exceeded');
      }
      const assignedStay = payerStayId ? table.assignedRoomStays.find((entry) => entry.id === payerStayId) : null;
      const roomGuestsSnapshot = assignedStay ? [{ roomNumber: assignedStay.room.roomNumber, guestName: assignedStay.primaryGuestName, guestNames: [...new Set([assignedStay.primaryGuestName, ...assignedStay.occupants.map((occupant) => occupant.name)])] }] : [];
      for (const order of orders) {
        if (folio) {
          const summary = order.items.map((line) => `${line.quantity}× ${line.menuItem.name}`).join(', ');
          await tx.roomCharge.create({ data: { stayId: payerStayId!, orderId: order.id, kind: 'RESTAURANT_ORDER', description: `Table ${table.tableNumber} restaurant order: ${summary}`, quantity: 1, unitPrice: Number(order.totalAmount), amount: Number(order.totalAmount), signedByName: dto.signedByName!.trim(), signatureData: dto.signatureData! } });
        }
        await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.COMPLETED, paymentMethod: dto.paymentMethod, paymentStatus: folio ? OrderPaymentStatus.ROOM_FOLIO : OrderPaymentStatus.PAID, ...(folio ? {} : { paidAt: now, paidById: cashierId }), roomGuestsSnapshot: roomGuestsSnapshot as Prisma.InputJsonValue } });
      }
      const remaining = await tx.order.count({ where: { tableId: id, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } } });
      if (remaining === 0) await tx.table.update({ where: { id }, data: { status: TableStatus.AVAILABLE, assignedRoomStays: { set: [] } } });
      return { tableId: id, tableNumber: table.tableNumber, paymentMethod: dto.paymentMethod, room: stay?.room ?? null, orderIds: orders.map((order) => order.id), totalAmount: orders.reduce((sum, order) => sum + Number(order.totalAmount), 0), signedByName: folio ? dto.signedByName!.trim() : null, checkedOutAt: now, tableCleared: remaining === 0 };
    });
  }
  async remove(id: string) {
    await this.findOne(id);
    const orders = await this.prisma.order.count({ where: { tableId: id } });
    if (orders) throw new ConflictException('A table with order history cannot be deleted');
    return this.prisma.table.delete({ where: { id } });
  }
}
