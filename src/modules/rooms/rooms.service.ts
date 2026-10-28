import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { OrderPaymentStatus, OrderStatus, RoomChargeKind, RoomPaymentMethod, RoomStatus } from 'prisma/generated/prisma/enums';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CheckInRoomDto } from './dto/check-in-room.dto';
import { CreateRoomChargeDto } from './dto/create-room-charge.dto';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { UpdateRoomStatusDto } from './dto/update-room-status.dto';
import { UpdateRoomStayDto } from './dto/update-room-stay.dto';
import { SettleRoomStayDto } from './dto/settle-room-stay.dto';

@Injectable()
export class RoomsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.room.findMany({
      orderBy: { roomNumber: 'asc' },
      include: { stays: { where: { checkedOutAt: null }, take: 1, include: { occupants: true, charges: { where: { settledAt: null }, select: { amount: true } }, _count: { select: { charges: true, orders: true } } } }, _count: { select: { stays: true } } },
    });
  }

  async create(dto: CreateRoomDto) {
    try { return await this.prisma.room.create({ data: { roomNumber: dto.roomNumber } }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Room number already exists'); throw error; }
  }

  async update(id: string, dto: UpdateRoomDto) {
    await this.findRoom(id);
    try { return await this.prisma.room.update({ where: { id }, data: dto }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Room number already exists'); throw error; }
  }

  async updateStatus(id: string, status: UpdateRoomStatusDto['status']) {
    await this.findRoom(id);
    if (status === RoomStatus.OCCUPIED) throw new BadRequestException('Rooms become occupied through guest check-in');
    const activeStay = await this.prisma.roomStay.count({ where: { roomId: id, checkedOutAt: null } });
    if (activeStay) throw new ConflictException('Check guests out before changing room availability');
    return this.prisma.room.update({ where: { id }, data: { status } });
  }

  async remove(id: string, deleteHistory = false) {
    await this.findRoom(id);
    const stays = await this.prisma.roomStay.findMany({ where: { roomId: id }, select: { id: true, checkedOutAt: true } });
    if (stays.some((stay) => stay.checkedOutAt === null)) throw new ConflictException('Check guests out before deleting this room');
    if (stays.length && !deleteHistory) throw new ConflictException('Room has stay history. Archive it or explicitly delete its full history.');
    if (!stays.length) return this.prisma.room.delete({ where: { id } });
    const stayIds = stays.map((stay) => stay.id);
    await this.prisma.$transaction(async (tx) => {
      // Explicit permanent deletion also removes room-service tickets and folio charges.
      await tx.roomCharge.deleteMany({ where: { stayId: { in: stayIds } } });
      await tx.order.deleteMany({ where: { roomStayId: { in: stayIds } } });
      await tx.roomStay.deleteMany({ where: { id: { in: stayIds } } });
      await tx.room.delete({ where: { id } });
    });
    return { id, deleted: true, historyDeleted: true };
  }

  async checkIn(roomId: string, dto: CheckInRoomDto) {
    await this.findRoom(roomId);
    const names = [...new Set([dto.primaryGuestName, ...(dto.occupants ?? [])].map((name) => name.trim()).filter(Boolean))];
    if (!names.length) throw new BadRequestException('Enter at least one guest name');
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.room.updateMany({ where: { id: roomId, status: RoomStatus.AVAILABLE }, data: { status: RoomStatus.OCCUPIED } });
      if (!claimed.count) throw new ConflictException('Room is already occupied');
      const stay = await tx.roomStay.create({
        data: {
          roomId,
          primaryGuestName: dto.primaryGuestName.trim(),
          occupants: { create: names.map((name) => ({ name })) },
          ...(dto.expectedCheckoutAt ? { expectedCheckoutAt: new Date(dto.expectedCheckoutAt) } : {}),
          ...(dto.guestNotes !== undefined ? { guestNotes: dto.guestNotes.trim() || null } : {}),
          cashOnly: dto.cashOnly ?? false,
          ...(dto.chargeLimit !== undefined ? { chargeLimit: dto.chargeLimit === null ? null : new Prisma.Decimal(dto.chargeLimit) } : {}),
        },
      });
      return tx.roomStay.findUniqueOrThrow({ where: { id: stay.id }, include: this.stayDetails() });
    });
  }

  async addCharge(stayId: string, dto: CreateRoomChargeDto) {
    const stay = await this.prisma.roomStay.findUnique({ where: { id: stayId }, include: { charges: { where: { settledAt: null }, select: { amount: true } } } });
    if (!stay) throw new NotFoundException('Room stay not found');
    if (stay.checkedOutAt) throw new ConflictException('Cannot add charges after checkout');
    if (stay.cashOnly) throw new ConflictException('This guest stay is set to cash only');
    if (dto.kind === RoomChargeKind.ROOM_FEE || dto.kind === RoomChargeKind.RESTAURANT_ORDER) {
      throw new BadRequestException('Room fee and restaurant order charges are created automatically');
    }
    const description = dto.description.trim();
    if (!description) throw new BadRequestException('Charge description is required');
    const unitPrice = new Prisma.Decimal(dto.unitPrice);
    const amount = unitPrice.mul(dto.quantity);
    if (stay.chargeLimit !== null) {
      const current = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      if (current + Number(amount) > Number(stay.chargeLimit)) throw new ConflictException('This guest stay charge limit would be exceeded');
    }
    return this.prisma.$transaction(async (tx) => {
      const stillActive = await tx.roomStay.updateMany({ where: { id: stayId, checkedOutAt: null }, data: { checkedOutAt: null } });
      if (!stillActive.count) throw new ConflictException('Cannot add charges after checkout');
      return tx.roomCharge.create({ data: { stayId, kind: dto.kind, description, quantity: dto.quantity, unitPrice, amount } });
    });
  }

  async updateStay(stayId: string, dto: UpdateRoomStayDto) {
    const stay = await this.prisma.roomStay.findUnique({ where: { id: stayId }, select: { id: true, checkedOutAt: true } });
    if (!stay) throw new NotFoundException('Room stay not found');
    if (stay.checkedOutAt) throw new ConflictException('Cannot edit a checked-out stay');
    const { occupants, expectedCheckoutAt, chargeLimit, primaryGuestName, ...fields } = dto;
    return this.prisma.roomStay.update({
      where: { id: stayId },
      data: {
        ...fields,
        ...(primaryGuestName !== undefined ? { primaryGuestName: primaryGuestName.trim() } : {}),
        ...(expectedCheckoutAt !== undefined ? { expectedCheckoutAt: expectedCheckoutAt ? new Date(expectedCheckoutAt) : null } : {}),
        ...(chargeLimit !== undefined ? { chargeLimit: chargeLimit === null ? null : new Prisma.Decimal(chargeLimit) } : {}),
        ...(occupants !== undefined ? { occupants: { deleteMany: {}, create: [...new Set(occupants.map((name) => name.trim()).filter(Boolean))].map((name) => ({ name })) } } : {}),
      },
      include: this.stayDetails(),
    });
  }

  async timeline(stayId: string) {
    const stay = await this.prisma.roomStay.findUnique({ where: { id: stayId }, include: this.stayDetails() });
    if (!stay) throw new NotFoundException('Room stay not found');
    const grossTotal = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
    const folioTotal = stay.charges.filter((charge) => !charge.settledAt).reduce((sum, charge) => sum + Number(charge.amount), 0);
    const paidTotal = stay.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
    return { ...stay, folioTotal, grossTotal, paidTotal, balanceDue: folioTotal };
  }

  async settle(stayId: string, receivedById: string, dto: SettleRoomStayDto) {
    return this.prisma.$transaction(async (tx) => {
      const stay = await tx.roomStay.findUnique({ where: { id: stayId }, include: { charges: { where: { settledAt: null }, select: { id: true, orderId: true, amount: true } } } });
      if (!stay) throw new NotFoundException('Room stay not found');
      if (stay.checkedOutAt) throw new ConflictException('Cannot settle a checked-out stay');
      const amount = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      if (amount <= 0) throw new ConflictException('There is no open room tab to settle');
      const now = new Date();
      await tx.roomPayment.create({ data: { stayId, amount: new Prisma.Decimal(amount), method: dto.method, note: dto.note?.trim() || null, receivedById } });
      await tx.roomCharge.updateMany({ where: { id: { in: stay.charges.map((charge) => charge.id) } }, data: { settledAt: now } });
      const orderIds = stay.charges.flatMap((charge) => charge.orderId ? [charge.orderId] : []);
      if (orderIds.length) await tx.order.updateMany({ where: { id: { in: orderIds }, paymentStatus: OrderPaymentStatus.ROOM_FOLIO }, data: { paymentMethod: dto.method === RoomPaymentMethod.CARD ? 'CARD' : 'CASH', paymentStatus: OrderPaymentStatus.PAID, paidAt: now, paidById: receivedById } });
      const result = await tx.roomStay.findUniqueOrThrow({ where: { id: stayId }, include: this.stayDetails() });
      const openTotal = result.charges.filter((charge) => !charge.settledAt).reduce((sum, charge) => sum + Number(charge.amount), 0);
      const paidTotal = result.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
      const grossTotal = result.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      return { ...result, folioTotal: openTotal, grossTotal, paidTotal, balanceDue: openTotal };
    });
  }

  async history(roomId: string) {
    await this.findRoom(roomId);
    return this.prisma.roomStay.findMany({
      where: { roomId },
      orderBy: { checkedInAt: 'desc' },
      include: this.stayDetails(),
    });
  }

  async checkOut(stayId: string) {
    return this.prisma.$transaction(async (tx) => {
      const stay = await tx.roomStay.findUnique({ where: { id: stayId }, include: { room: true, charges: { where: { settledAt: null }, select: { amount: true } } } });
      if (!stay) throw new NotFoundException('Room stay not found');
      if (stay.checkedOutAt) throw new ConflictException('This guest has already checked out');
      const openBalance = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      if (openBalance > 0) throw new ConflictException('Settle the room tab before checking out');
      const assignedTables = await tx.table.findMany({ where: { assignedRoomStays: { some: { id: stayId } } }, select: { id: true } });
      if (assignedTables.length) {
        const openTableOrders = await tx.order.count({
          where: { tableId: { in: assignedTables.map((table) => table.id) }, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } },
        });
        if (openTableOrders) throw new ConflictException('Settle the orders on this guest’s assigned restaurant table before checking out');
        await Promise.all(assignedTables.map((table) => tx.table.update({ where: { id: table.id }, data: { assignedRoomStays: { disconnect: { id: stayId } } } })));
      }
      const changed = await tx.roomStay.updateMany({ where: { id: stayId, checkedOutAt: null }, data: { checkedOutAt: new Date() } });
      if (!changed.count) throw new ConflictException('This guest has already checked out');
      const currentStay = await tx.roomStay.count({ where: { roomId: stay.roomId, checkedOutAt: null } });
      if (currentStay === 0) await tx.room.update({ where: { id: stay.roomId }, data: { status: RoomStatus.AVAILABLE } });
      const result = await tx.roomStay.findUniqueOrThrow({ where: { id: stayId }, include: this.stayDetails() });
      const grossTotal = result.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      const paidTotal = result.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
      return { ...result, folioTotal: result.charges.filter((charge) => !charge.settledAt).reduce((sum, charge) => sum + Number(charge.amount), 0), grossTotal, paidTotal, balanceDue: result.charges.filter((charge) => !charge.settledAt).reduce((sum, charge) => sum + Number(charge.amount), 0) };
    });
  }

  private async findRoom(id: string) {
    const room = await this.prisma.room.findUnique({ where: { id } });
    if (!room) throw new NotFoundException('Room not found');
    return room;
  }

  private stayDetails() {
    return {
      room: true,
      occupants: true,
      charges: { orderBy: { occurredAt: 'asc' as const } },
      payments: { orderBy: { paidAt: 'asc' as const }, include: { receivedBy: { select: { id: true, name: true } } } },
      orders: { orderBy: { createdAt: 'asc' as const }, include: { items: { include: { menuItem: true } }, table: true, waiter: { select: { id: true, name: true } }, servedBy: { select: { id: true, name: true } }, paidBy: { select: { id: true, name: true } } } },
    };
  }
}

