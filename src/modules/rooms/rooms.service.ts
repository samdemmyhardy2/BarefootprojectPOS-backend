import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { RoomChargeKind, RoomStatus } from 'prisma/generated/prisma/enums';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CheckInRoomDto } from './dto/check-in-room.dto';
import { CreateRoomChargeDto } from './dto/create-room-charge.dto';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { UpdateRoomStatusDto } from './dto/update-room-status.dto';

@Injectable()
export class RoomsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.room.findMany({
      orderBy: { roomNumber: 'asc' },
      include: { stays: { where: { checkedOutAt: null }, take: 1, include: { occupants: true, _count: { select: { charges: true, orders: true } } } }, _count: { select: { stays: true } } },
    });
  }

  async create(dto: CreateRoomDto) {
    const facilities = this.cleanFacilities(dto.facilities);
    try { return await this.prisma.room.create({ data: { ...dto, facilities, usageFee: dto.usageFee ?? 0 } }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Room number already exists'); throw error; }
  }

  async update(id: string, dto: UpdateRoomDto) {
    await this.findRoom(id);
    const data = { ...dto, ...(dto.facilities !== undefined ? { facilities: this.cleanFacilities(dto.facilities) } : {}) };
    try { return await this.prisma.room.update({ where: { id }, data }); }
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
    const room = await this.findRoom(roomId);
    const names = [...new Set([dto.primaryGuestName, ...(dto.occupants ?? [])].map((name) => name.trim()).filter(Boolean))];
    if (!names.length) throw new BadRequestException('Enter at least one guest name');
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.room.updateMany({ where: { id: roomId, status: RoomStatus.AVAILABLE }, data: { status: RoomStatus.OCCUPIED } });
      if (!claimed.count) throw new ConflictException('Room is already occupied');
      const stay = await tx.roomStay.create({
        data: { roomId, primaryGuestName: dto.primaryGuestName.trim(), occupants: { create: names.map((name) => ({ name })) } },
      });
      if (Number(room.usageFee) > 0) {
        await tx.roomCharge.create({ data: { stayId: stay.id, kind: RoomChargeKind.ROOM_FEE, description: 'Room usage fee', quantity: 1, unitPrice: room.usageFee, amount: room.usageFee } });
      }
      return tx.roomStay.findUniqueOrThrow({ where: { id: stay.id }, include: this.stayDetails() });
    });
  }

  async addCharge(stayId: string, dto: CreateRoomChargeDto) {
    await this.activeStay(stayId);
    if (dto.kind === RoomChargeKind.ROOM_FEE || dto.kind === RoomChargeKind.RESTAURANT_ORDER) {
      throw new BadRequestException('Room fee and restaurant order charges are created automatically');
    }
    const description = dto.description.trim();
    if (!description) throw new BadRequestException('Charge description is required');
    const unitPrice = new Prisma.Decimal(dto.unitPrice);
    return this.prisma.$transaction(async (tx) => {
      const stillActive = await tx.roomStay.updateMany({ where: { id: stayId, checkedOutAt: null }, data: { checkedOutAt: null } });
      if (!stillActive.count) throw new ConflictException('Cannot add charges after checkout');
      return tx.roomCharge.create({ data: { stayId, kind: dto.kind, description, quantity: dto.quantity, unitPrice, amount: unitPrice.mul(dto.quantity) } });
    });
  }

  async timeline(stayId: string) {
    const stay = await this.prisma.roomStay.findUnique({ where: { id: stayId }, include: this.stayDetails() });
    if (!stay) throw new NotFoundException('Room stay not found');
    const folioTotal = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
    return { ...stay, folioTotal };
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
      const stay = await tx.roomStay.findUnique({ where: { id: stayId }, include: { room: true } });
      if (!stay) throw new NotFoundException('Room stay not found');
      if (stay.checkedOutAt) throw new ConflictException('This guest has already checked out');
      const changed = await tx.roomStay.updateMany({ where: { id: stayId, checkedOutAt: null }, data: { checkedOutAt: new Date() } });
      if (!changed.count) throw new ConflictException('This guest has already checked out');
      // Backfill a room fee at checkout if this stay was created before the
      // automatic check-in fee posting was in place. Never double-charge it.
      const hasRoomFee = await tx.roomCharge.findFirst({ where: { stayId, kind: RoomChargeKind.ROOM_FEE }, select: { id: true } });
      if (!hasRoomFee && Number(stay.room.usageFee) > 0) {
        await tx.roomCharge.create({ data: { stayId, kind: RoomChargeKind.ROOM_FEE, description: 'Room usage fee', quantity: 1, unitPrice: stay.room.usageFee, amount: stay.room.usageFee } });
      }
      const currentStay = await tx.roomStay.count({ where: { roomId: stay.roomId, checkedOutAt: null } });
      if (currentStay === 0) await tx.room.update({ where: { id: stay.roomId }, data: { status: RoomStatus.AVAILABLE } });
      const result = await tx.roomStay.findUniqueOrThrow({ where: { id: stayId }, include: this.stayDetails() });
      return { ...result, folioTotal: result.charges.reduce((sum, charge) => sum + Number(charge.amount), 0) };
    });
  }

  private async findRoom(id: string) {
    const room = await this.prisma.room.findUnique({ where: { id } });
    if (!room) throw new NotFoundException('Room not found');
    return room;
  }

  private cleanFacilities(facilities?: string[]) {
    return [...new Set((facilities ?? []).map((facility) => facility.trim()).filter(Boolean))];
  }

  private async activeStay(id: string) {
    const stay = await this.prisma.roomStay.findUnique({ where: { id }, select: { id: true, checkedOutAt: true } });
    if (!stay) throw new NotFoundException('Room stay not found');
    if (stay.checkedOutAt) throw new ConflictException('Cannot add charges after checkout');
    return stay;
  }

  private stayDetails() {
    return {
      room: true,
      occupants: true,
      charges: { orderBy: { occurredAt: 'asc' as const } },
      orders: { orderBy: { createdAt: 'asc' as const }, include: { items: { include: { menuItem: true } }, table: true, waiter: { select: { id: true, name: true } }, servedBy: { select: { id: true, name: true } } } },
    };
  }
}
