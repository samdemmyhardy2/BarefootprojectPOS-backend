import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { InboundEmailStatus, OrderPaymentStatus, OrderStatus, RoomChargeKind, RoomPaymentMethod, RoomStatus } from 'prisma/generated/prisma/enums';
import { atBangkokHour, bangkokClock, bangkokDayKey, CloudbedsEmailReservation, pickImportedStay, planStayNotice, type StayNoticePatch } from './cloudbeds-email';
import { planImportedRoom, sameRoomNumber, suggestedRoomNumbers } from './room-assignment';
import { IdempotencyService } from '../../utils/prisma/idempotency.service';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CheckInRoomDto } from './dto/check-in-room.dto';
import { CreateRoomChargeDto } from './dto/create-room-charge.dto';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { UpdateRoomStatusDto } from './dto/update-room-status.dto';
import { UpdateRoomStayDto } from './dto/update-room-stay.dto';
import { RemoveChargeLineDto, SettleRoomStayDto, SignRoomChargeDto } from './dto/settle-room-stay.dto';
import { presentOrder } from '../orders/orders.service';
import { exactTotalWithVat, folioPayable, moneyRound, totalWithVat } from '../../common/vat';

export function compareRoomNumbers(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

@Injectable()
export class RoomsService {
  constructor(private readonly prisma: PrismaService, private readonly idempotency: IdempotencyService) {}

  async findAll() {
    const now = new Date();
    const rooms = await this.prisma.room.findMany({
      include: { stays: { where: { cancelledAt: null, checkedOutAt: null, checkedInAt: { lte: now }, OR: [{ expectedCheckoutAt: null }, { expectedCheckoutAt: { gt: now } }] }, orderBy: { checkedInAt: 'desc' }, take: 1, include: { occupants: true, charges: { where: { settledAt: null, kind: { not: RoomChargeKind.ROOM_FEE } }, select: { amount: true } }, _count: { select: { charges: true, orders: true } } } }, _count: { select: { stays: true } } },
    });
    return rooms.sort((left, right) => compareRoomNumbers(left.roomNumber, right.roomNumber));
  }

  async calendar(from: string, to: string) {
    if (from > to) throw new BadRequestException('The calendar start date must be on or before the end date');
    const fromDate = new Date(`${from}T00:00:00`);
    const toDate = new Date(`${to}T00:00:00`);
    const rooms = await this.prisma.room.findMany({
      include: {
        stays: {
          where: this.stayWindow(fromDate, toDate),
          include: { occupants: true },
          orderBy: { checkedInAt: 'asc' },
        },
      },
    });
    const unassigned = await this.prisma.roomStay.findMany({
      where: { roomId: null, ...this.stayWindow(fromDate, toDate) },
      include: { occupants: true },
      orderBy: { checkedInAt: 'asc' },
    });
    const rows = rooms.sort((left, right) => compareRoomNumbers(left.roomNumber, right.roomNumber)).map((room) => ({
      id: room.id,
      roomNumber: room.roomNumber,
      status: room.status,
      stays: room.stays.map((stay) => this.calendarStay(stay, toDate)),
    }));
    if (unassigned.length) rows.unshift({ id: 'unassigned', roomNumber: 'Unassigned', status: RoomStatus.AVAILABLE, stays: unassigned.map((stay) => this.calendarStay(stay, toDate)) });
    return { from, to, rooms: rows };
  }

  private stayWindow(fromDate: Date, toDate: Date): Prisma.RoomStayWhereInput {
    return {
      cancelledAt: null,
      checkedInAt: { lt: toDate },
      OR: [
        { checkedOutAt: { gt: fromDate } },
        { checkedOutAt: null, expectedCheckoutAt: { gt: fromDate } },
        { checkedOutAt: null, expectedCheckoutAt: null },
      ],
    };
  }

  private calendarStay(stay: { id: string; primaryGuestName: string; checkedInAt: Date; checkedOutAt: Date | null; expectedCheckoutAt: Date | null; occupants: { id: string }[]; guestNotes: string | null; adults: number | null; children: number | null; bookingSource: string | null; confirmationNumber: string | null; roomType: string | null }, toDate: Date) {
    const start = stay.checkedInAt;
    const plannedLeave = stay.checkedOutAt ?? stay.expectedCheckoutAt;
    const leave = plannedLeave ?? toDate;
    let end = this.dayKey(leave);
    const startKey = this.dayKey(start);
    if (end <= startKey) end = this.dayKey(new Date(start.getTime() + 24 * 60 * 60 * 1000));
    return {
      id: stay.id,
      guestName: stay.primaryGuestName,
      startDate: startKey,
      endDate: end,
      arriveTime: this.clock(start),
      leaveTime: plannedLeave ? this.clock(plannedLeave) : '',
      leaveDate: plannedLeave ? this.dayKey(plannedLeave) : '',
      adults: String(stay.adults ?? Math.max(stay.occupants.length, 1)),
      children: String(stay.children ?? 0),
      source: stay.bookingSource,
      confirmationNumber: stay.confirmationNumber,
      roomType: stay.roomType,
      guestNotes: stay.guestNotes,
      checkedOut: Boolean(stay.checkedOutAt),
    };
  }

  async importEmailReservation(reservation: CloudbedsEmailReservation, notice?: { noticeAt?: Date | null; reference?: string | null }) {
    const source = reservation.source.trim() || 'Cloudbeds';
    const confirmationNumber = reservation.confirmationNumber.trim();
    const noticeAt = notice?.noticeAt ?? null;
    const reference = notice?.reference ?? null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const lockKey = reservation.cloudbedsReservationId ? `cloudbeds-id:${reservation.cloudbedsReservationId}` : `cloudbeds:${confirmationNumber}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}), hashtext('room-stay'))`;
        const candidates = await tx.roomStay.findMany({
          where: {
            OR: [
              { confirmationNumber },
              ...(reservation.sourceReservationId ? [{ sourceReservationId: reservation.sourceReservationId }] : []),
              ...(reservation.cloudbedsReservationId ? [{ cloudbedsReservationId: reservation.cloudbedsReservationId }] : []),
            ],
          },
        });
        const picked = pickImportedStay(candidates, reservation);
        if (picked.ambiguous) return { action: 'review' as const, stayId: null, detail: `Manual review: more than one reservation matches confirmation ${confirmationNumber}.`, match: this.matchInfo(reservation, picked.strategy, null, 'SKIP') };
        const existing = picked.stay;
        const latest = existing
          ? await tx.inboundEmail.findFirst({
            where: { stayId: existing.id, noticeAt: { not: null }, status: { in: [InboundEmailStatus.PROCESSED, InboundEmailStatus.DUPLICATE] } },
            orderBy: { noticeAt: 'desc' },
            select: { noticeAt: true },
          })
          : null;
        const decision = planStayNotice({
          existing: existing ? {
            primaryGuestName: existing.primaryGuestName,
            guestNotes: existing.guestNotes,
            bookingSource: existing.bookingSource,
            amountPaid: existing.amountPaid?.toString() ?? null,
            cloudbedsReservationId: existing.cloudbedsReservationId,
            cancelledAt: existing.cancelledAt,
            latestNoticeAt: latest?.noticeAt ?? null,
            checkedInAt: existing.checkedInAt,
            expectedCheckoutAt: existing.expectedCheckoutAt,
            roomType: existing.roomType,
            grandTotal: existing.grandTotal?.toString() ?? null,
          } : null,
          reservation,
          noticeAt,
          reference,
        });
        if (decision.action === 'review') return { action: 'review' as const, stayId: null, detail: decision.detail, match: this.matchInfo(reservation, picked.strategy, null, 'SKIP') };
        if (decision.action === 'stale') return { action: 'stale' as const, stayId: existing?.id ?? null, detail: decision.detail, match: this.matchInfo(reservation, picked.strategy, existing?.id ?? null, 'SKIP') };
        if (decision.action === 'duplicate') return { action: 'duplicate' as const, stayId: existing?.id ?? null, detail: null, match: this.matchInfo(reservation, picked.strategy, existing?.id ?? null, 'SKIP') };
        if (decision.action === 'cancel' && existing && decision.patch) {
          await tx.roomStay.update({ where: { id: existing.id }, data: this.noticeData(decision.patch) });
          if (!existing.cancelledAt && existing.roomId) {
            const current = await tx.roomStay.count({ where: { roomId: existing.roomId, checkedOutAt: null, cancelledAt: null, checkedInAt: { lte: new Date() } } });
            if (current === 0) await tx.room.updateMany({ where: { id: existing.roomId, status: RoomStatus.OCCUPIED }, data: { status: RoomStatus.AVAILABLE } });
          }
          return { action: 'cancelled' as const, stayId: existing.id, detail: null, match: this.matchInfo(reservation, picked.strategy, existing.id, 'CANCEL') };
        }
        const assignment = await this.planEmailRoom(tx, reservation, existing?.id, existing?.roomId ?? null, existing?.assignmentReason ?? null);
        if (decision.action === 'modify' && existing && decision.patch) {
          if (assignment.needsReview) {
            const warning = 'Room assignment needs review: the previous room is not available for the updated dates.';
            decision.patch.guestNotes = decision.patch.guestNotes?.includes(warning) ? decision.patch.guestNotes : `${decision.patch.guestNotes ? `${decision.patch.guestNotes.trim()} ` : ''}${warning}`;
          }
          if (decision.replaceNights) await tx.reservationNight.deleteMany({ where: { stayId: existing.id } });
          const data: Prisma.RoomStayUncheckedUpdateInput = {
            ...this.noticeData(decision.patch),
            roomId: assignment.roomId,
            assignmentReason: assignment.assignmentReason,
            ...(decision.replaceNights ? { nightlyRates: { create: this.nightRows(reservation) } } : {}),
          };
          await tx.roomStay.update({ where: { id: existing.id }, data });
          if (existing.roomId && assignment.roomId !== existing.roomId) {
            const others = await tx.roomStay.count({ where: { roomId: existing.roomId, id: { not: existing.id }, checkedOutAt: null, cancelledAt: null, checkedInAt: { lte: new Date() } } });
            if (others === 0) await tx.room.updateMany({ where: { id: existing.roomId, status: RoomStatus.OCCUPIED }, data: { status: RoomStatus.AVAILABLE } });
          }
          if (assignment.roomId && assignment.roomId !== existing.roomId && reservation.checkIn.getTime() <= Date.now()) {
            const inHouse = await tx.roomStay.count({ where: { roomId: assignment.roomId, checkedOutAt: null, cancelledAt: null, checkedInAt: { lte: new Date() } } });
            if (inHouse >= 1) await tx.room.updateMany({ where: { id: assignment.roomId, status: RoomStatus.AVAILABLE }, data: { status: RoomStatus.OCCUPIED } });
          }
          const guestName = reservation.guestName.trim();
          if (guestName && guestName !== existing.primaryGuestName) {
            const namedGuest = await tx.roomOccupant.findFirst({ where: { stayId: existing.id, name: existing.primaryGuestName } });
            if (namedGuest) await tx.roomOccupant.update({ where: { id: namedGuest.id }, data: { name: guestName } });
            else await tx.roomOccupant.create({ data: { stayId: existing.id, name: guestName } });
          }
          return { action: 'modified' as const, stayId: existing.id, detail: assignment.needsReview ? 'Room assignment needs review: the previous room is not available for the updated dates.' : null, match: this.matchInfo(reservation, picked.strategy, existing.id, 'UPDATE'), changes: this.stayChanges(existing, reservation) };
        }
        const notes = ['Imported from a forwarded Cloudbeds email.'];
        if (reservation.roomType) notes.push(`Room type: ${reservation.roomType}.`);
        if (assignment.assignmentReason) notes.push(assignment.assignmentReason);
        const priorCancellation = await tx.inboundEmail.findFirst({
          where: { confirmationNumber, noticeKind: 'CANCELLED', status: { in: [InboundEmailStatus.SKIPPED, InboundEmailStatus.PROCESSED, InboundEmailStatus.DUPLICATE, InboundEmailStatus.FAILED] } },
          orderBy: { noticeAt: 'desc' },
          select: { noticeAt: true },
        });
        if (priorCancellation && !noticeAt) return { action: 'review' as const, stayId: null, detail: 'Manual review: this confirmation has no date and a cancellation is already stored for it.', match: this.matchInfo(reservation, 'none', null, 'SKIP') };
        const superseded = Boolean(priorCancellation?.noticeAt && noticeAt && priorCancellation.noticeAt.getTime() > noticeAt.getTime());
        const data = this.reservationRecord(reservation, source, confirmationNumber, superseded ? null : assignment.roomId, notes.join(' '), superseded ? null : assignment.assignmentReason);
        const stay = await tx.roomStay.create({
          data: {
            ...data,
            ...(superseded && priorCancellation?.noticeAt ? { cancelledAt: priorCancellation.noticeAt, guestNotes: `${data.guestNotes} Cancelled from a Cloudbeds email that was already stored.` } : {}),
            occupants: { create: [{ name: reservation.guestName.trim() }] },
            nightlyRates: { create: this.nightRows(reservation) },
          },
        });
        if (!superseded && assignment.roomId && reservation.checkIn.getTime() <= Date.now()) {
          const inHouse = await tx.roomStay.count({ where: { roomId: assignment.roomId, checkedOutAt: null, cancelledAt: null, checkedInAt: { lte: new Date() } } });
          if (inHouse <= 1) await tx.room.updateMany({ where: { id: assignment.roomId, status: RoomStatus.AVAILABLE }, data: { status: RoomStatus.OCCUPIED } });
        }
        return { action: 'created' as const, stayId: stay.id, detail: superseded ? 'Confirmation was older than a cancellation already on file. The reservation was stored as canceled.' : null, match: this.matchInfo(reservation, 'none', stay.id, superseded ? 'CANCEL' : 'CREATE') };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.roomStay.findFirst({ where: { bookingSource: source, confirmationNumber }, select: { id: true } });
        return { action: 'duplicate' as const, stayId: existing?.id ?? null, detail: null, match: this.matchInfo(reservation, 'confirmationNumber', existing?.id ?? null, 'SKIP') };
      }
      throw error;
    }
  }

  private matchInfo(reservation: CloudbedsEmailReservation, strategy: string, stayId: string | null, operation: 'CREATE' | 'UPDATE' | 'CANCEL' | 'SKIP') {
    return {
      cloudbedsReservationId: reservation.cloudbedsReservationId,
      confirmationNumber: reservation.confirmationNumber,
      sourceReservationId: reservation.sourceReservationId,
      strategy,
      stayId,
      found: Boolean(stayId) && operation !== 'CREATE',
      operation,
    };
  }

  private stayChanges(existing: { checkedInAt: Date; expectedCheckoutAt: Date | null; roomType: string | null; grandTotal: { toString(): string } | null; primaryGuestName: string; adults: number | null; children: number | null }, reservation: CloudbedsEmailReservation) {
    return {
      checkIn: bangkokDayKey(existing.checkedInAt) !== bangkokDayKey(reservation.checkIn),
      checkOut: existing.expectedCheckoutAt ? bangkokDayKey(existing.expectedCheckoutAt) !== bangkokDayKey(reservation.checkOut) : true,
      roomType: (existing.roomType ?? null) !== (reservation.roomType ?? null),
      price: (existing.grandTotal?.toString() ?? null) !== (reservation.grandTotal ?? null),
      guest: existing.primaryGuestName !== reservation.guestName.trim() || existing.adults !== reservation.adults || existing.children !== reservation.children,
    };
  }

  private async planEmailRoom(tx: Prisma.TransactionClient, reservation: CloudbedsEmailReservation, stayId: string | undefined, currentRoomId: string | null, currentReason: string | null) {
    const inventory = await tx.room.findMany({ select: { id: true, roomNumber: true, status: true } });
    const overlapping = await tx.roomStay.findMany({
      where: {
        cancelledAt: null,
        checkedOutAt: null,
        roomId: { not: null },
        checkedInAt: { lt: reservation.checkOut },
        OR: [{ expectedCheckoutAt: null }, { expectedCheckoutAt: { gt: reservation.checkIn } }],
        ...(stayId ? { id: { not: stayId } } : {}),
      },
      select: { roomId: true },
    });
    const occupiedRoomNumbers = inventory.filter((room) => overlapping.some((stay) => stay.roomId === room.id)).map((room) => room.roomNumber);
    const current = currentRoomId ? inventory.find((room) => room.id === currentRoomId) ?? null : null;
    const plan = planImportedRoom({
      roomType: reservation.roomType,
      inventory,
      occupiedRoomNumbers,
      currentRoomNumber: current?.roomNumber ?? null,
      currentStatus: current?.status ?? null,
    });
    let roomId: string | null = null;
    let assignmentReason = current ? currentReason : plan.reason;
    let needsReview = plan.needsReview;
    if (plan.roomNumber) {
      const room = current && sameRoomNumber(current.roomNumber, plan.roomNumber) ? current : inventory.find((item) => sameRoomNumber(item.roomNumber, plan.roomNumber!));
      if (room) {
        await tx.$queryRaw`SELECT id FROM "Room" WHERE id = ${room.id} FOR UPDATE`;
        const clash = await tx.roomStay.count({ where: this.overlapWhere(reservation.checkIn, reservation.checkOut, room.id, stayId) });
        if (clash || room.status === RoomStatus.MAINTENANCE || room.status === RoomStatus.ARCHIVED) {
          roomId = null;
          assignmentReason = room.status === RoomStatus.MAINTENANCE || room.status === RoomStatus.ARCHIVED ? 'UNASSIGNED_UNAVAILABLE' : 'UNASSIGNED_OCCUPIED';
          needsReview = Boolean(current);
        } else {
          roomId = room.id;
          assignmentReason = current && room.id === current.id ? currentReason : plan.reason;
          needsReview = false;
        }
      }
    } else if (needsReview) assignmentReason = plan.reason;
    return { roomId, assignmentReason, needsReview };
  }

  private noticeData(patch: StayNoticePatch): Prisma.RoomStayUncheckedUpdateInput {
    const decimal = (value: string | null) => value === null ? null : new Prisma.Decimal(value);
    const data: Prisma.RoomStayUncheckedUpdateInput = {};
    if (patch.primaryGuestName !== undefined) data.primaryGuestName = patch.primaryGuestName;
    if (patch.guestEmail !== undefined) data.guestEmail = patch.guestEmail;
    if (patch.guestNotes !== undefined) data.guestNotes = patch.guestNotes;
    if (patch.bookingSource !== undefined) data.bookingSource = patch.bookingSource;
    if (patch.sourceReservationId !== undefined) data.sourceReservationId = patch.sourceReservationId;
    if (patch.cloudbedsReservationId !== undefined) data.cloudbedsReservationId = patch.cloudbedsReservationId;
    if (patch.roomType !== undefined) data.roomType = patch.roomType;
    if (patch.adults !== undefined) data.adults = patch.adults;
    if (patch.children !== undefined) data.children = patch.children;
    if (patch.nights !== undefined) data.nights = patch.nights;
    if (patch.currency !== undefined) data.currency = patch.currency;
    if (patch.averageNightlyRate !== undefined) data.averageNightlyRate = decimal(patch.averageNightlyRate);
    if (patch.grandTotal !== undefined) data.grandTotal = decimal(patch.grandTotal);
    if (patch.depositAmount !== undefined) data.depositAmount = decimal(patch.depositAmount);
    if (patch.amountPaid !== undefined) data.amountPaid = decimal(patch.amountPaid);
    if (patch.balanceDue !== undefined) data.balanceDue = decimal(patch.balanceDue);
    if (patch.payment !== undefined) data.payment = patch.payment;
    if (patch.checkedInAt !== undefined) data.checkedInAt = patch.checkedInAt;
    if (patch.expectedCheckoutAt !== undefined) data.expectedCheckoutAt = patch.expectedCheckoutAt;
    if (patch.cancelledAt !== undefined) data.cancelledAt = patch.cancelledAt;
    return data;
  }

  private overlapWhere(checkIn: Date, checkOut: Date, roomId: string, exceptStayId?: string): Prisma.RoomStayWhereInput {
    return {
      roomId,
      cancelledAt: null,
      checkedOutAt: null,
      ...(exceptStayId ? { id: { not: exceptStayId } } : {}),
      checkedInAt: { lt: checkOut },
      OR: [{ expectedCheckoutAt: null }, { expectedCheckoutAt: { gt: checkIn } }],
    };
  }

  private reservationRecord(reservation: CloudbedsEmailReservation, source: string, confirmationNumber: string, roomId: string | null, notes: string, assignmentReason: string | null) {
    const checkOut = atBangkokHour(reservation.checkOut, 11);
    const decimal = (value: string | null) => value === null ? null : new Prisma.Decimal(value);
    return {
      roomId,
      primaryGuestName: reservation.guestName.trim(),
      guestEmail: reservation.guestEmail,
      bookingSource: source,
      confirmationNumber,
      sourceReservationId: reservation.sourceReservationId,
      cloudbedsReservationId: reservation.cloudbedsReservationId,
      roomType: reservation.roomType,
      assignmentReason,
      adults: reservation.adults,
      children: reservation.children,
      nights: reservation.nights,
      currency: reservation.currency,
      averageNightlyRate: decimal(reservation.averageNightlyRate),
      grandTotal: decimal(reservation.grandTotal),
      depositAmount: decimal(reservation.depositAmount),
      amountPaid: decimal(reservation.amountPaid),
      balanceDue: decimal(reservation.balanceDue),
      payment: {
        currency: reservation.currency,
        averageNightlyRate: reservation.averageNightlyRate,
        grandTotal: reservation.grandTotal,
        depositAmount: reservation.depositAmount,
        amountPaid: reservation.amountPaid,
        balanceDue: reservation.balanceDue,
        paymentMethod: reservation.paymentMethod,
      },
      checkedInAt: reservation.checkIn,
      expectedCheckoutAt: checkOut,
      guestNotes: notes,
    };
  }

  private nightRows(reservation: CloudbedsEmailReservation) {
    return reservation.nightlyRates.map((rate) => ({ night: rate.night, amount: new Prisma.Decimal(rate.amount), currency: rate.currency }));
  }

  private dayKey(value: Date) {
    return bangkokDayKey(value);
  }

  private clock(value: Date) {
    return bangkokClock(value);
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
    if (dto.checkedInAt && dto.expectedCheckoutAt && new Date(dto.expectedCheckoutAt).getTime() < new Date(dto.checkedInAt).getTime()) throw new BadRequestException('Checkout must be on or after check-in');
    try {
    const stay = await this.prisma.$transaction(async (tx) => {
      const prior = await this.idempotency.read(tx, 'room.check-in', dto.clientRequestId);
      if (prior) return prior;
      const room = await tx.room.findUnique({ where: { id: roomId }, select: { status: true } });
      if (!room) throw new NotFoundException('Room not found');
      if (room.status === RoomStatus.MAINTENANCE || room.status === RoomStatus.ARCHIVED) throw new ConflictException('That room is not available');
      const now = new Date();
      const inHouse = await tx.roomStay.count({
        where: {
          roomId,
          cancelledAt: null,
          checkedOutAt: null,
          checkedInAt: { lte: now },
          OR: [{ expectedCheckoutAt: null }, { expectedCheckoutAt: { gt: now } }],
        },
      });
      if (inHouse) throw new ConflictException('Room is already occupied');
      await tx.room.update({ where: { id: roomId }, data: { status: RoomStatus.OCCUPIED } });
      const stay = await tx.roomStay.create({
        data: {
          roomId,
          primaryGuestName: dto.primaryGuestName.trim(),
          occupants: { create: names.map((name) => ({ name })) },
          ...(dto.checkedInAt ? { checkedInAt: new Date(dto.checkedInAt) } : {}),
          ...(dto.expectedCheckoutAt ? { expectedCheckoutAt: new Date(dto.expectedCheckoutAt) } : {}),
          ...(dto.guestNotes !== undefined ? { guestNotes: dto.guestNotes.trim() || null } : {}),
          cashOnly: dto.cashOnly ?? false,
          ...(dto.chargeLimit !== undefined ? { chargeLimit: dto.chargeLimit === null ? null : new Prisma.Decimal(dto.chargeLimit) } : {}),
        },
      });
      const created = this.presentStay(await tx.roomStay.findUniqueOrThrow({ where: { id: stay.id }, include: this.stayDetails() }));
      await this.idempotency.write(tx, 'room.check-in', dto.clientRequestId, 'check-in', created);
      return created;
    });
    return stay;
    } catch (error) {
      const saved = await this.idempotency.recover(error, 'room.check-in', dto.clientRequestId);
      if (saved) return saved;
      throw error;
    }
  }

  async commissionItems() {
    const items = await this.prisma.commissionItem.findMany({ orderBy: { name: 'asc' } });
    return items.map((item) => ({ id: item.id, name: item.name, price: Number(item.price), commission: Number(item.commission) }));
  }

  async addCharge(stayId: string, dto: CreateRoomChargeDto) {
    const stay = await this.prisma.roomStay.findUnique({ where: { id: stayId }, include: { charges: { where: { settledAt: null, kind: { not: RoomChargeKind.ROOM_FEE } }, select: { amount: true } } } });
    if (!stay) throw new NotFoundException('Room stay not found');
    if (stay.checkedOutAt) throw new ConflictException('Cannot add charges after checkout');
    if (stay.cashOnly) throw new ConflictException('This guest stay is set to cash only');
    if (dto.kind === RoomChargeKind.ROOM_FEE || dto.kind === RoomChargeKind.RESTAURANT_ORDER) {
      throw new BadRequestException('Room fee and restaurant order charges are created automatically');
    }
    const saved = dto.commissionItemId
      ? await this.prisma.commissionItem.findUnique({ where: { id: dto.commissionItemId } })
      : null;
    if (dto.commissionItemId && !saved) throw new NotFoundException('Commission item not found');
    const description = (saved?.name ?? dto.description).trim();
    if (!description) throw new BadRequestException('Charge description is required');
    const unitPrice = new Prisma.Decimal(saved ? saved.price : dto.unitPrice);
    const amount = unitPrice.mul(dto.quantity);
    const commissionAmount = saved ? new Prisma.Decimal(saved.commission).mul(dto.quantity) : null;
    if (stay.chargeLimit !== null) {
      const current = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      if (current + Number(amount) > Number(stay.chargeLimit)) throw new ConflictException('This guest stay charge limit would be exceeded');
    }
    return this.prisma.$transaction(async (tx) => {
      const stillActive = await tx.roomStay.updateMany({ where: { id: stayId, checkedOutAt: null }, data: { checkedOutAt: null } });
      if (!stillActive.count) throw new ConflictException('Cannot add charges after checkout');
      return tx.roomCharge.create({ data: { stayId, kind: dto.kind, description, quantity: dto.quantity, unitPrice, amount, ...(saved ? { commissionItemId: saved.id, commissionAmount } : {}) } });
    });
  }

  async roomChoices(stayId: string) {
    const stay = await this.prisma.roomStay.findUnique({ where: { id: stayId }, select: { id: true, checkedInAt: true, expectedCheckoutAt: true, roomType: true, roomId: true, cancelledAt: true, checkedOutAt: true } });
    if (!stay) throw new NotFoundException('Room stay not found');
    const rooms = await this.prisma.room.findMany({ select: { id: true, roomNumber: true, status: true } });
    const clashes = await this.prisma.roomStay.findMany({
      where: {
        roomId: { not: null },
        id: { not: stayId },
        cancelledAt: null,
        checkedOutAt: null,
        ...(stay.expectedCheckoutAt ? { checkedInAt: { lt: stay.expectedCheckoutAt } } : {}),
        OR: [{ expectedCheckoutAt: null }, { expectedCheckoutAt: { gt: stay.checkedInAt } }],
      },
      select: { roomId: true },
    });
    const blocked = new Set(clashes.map((item) => item.roomId));
    const suggested = suggestedRoomNumbers(stay.roomType);
    return rooms.map((room) => {
      const matches = suggested.some((number) => sameRoomNumber(number, room.roomNumber));
      const unavailable = room.status === RoomStatus.MAINTENANCE || room.status === RoomStatus.ARCHIVED;
      const booked = blocked.has(room.id);
      const reason = unavailable ? (room.status === RoomStatus.MAINTENANCE ? 'Under maintenance' : 'Archived') : booked ? 'Booked for these dates' : null;
      return { id: room.id, roomNumber: room.roomNumber, status: room.status, suggested: matches, available: !unavailable && !booked && !stay.roomId && !stay.cancelledAt && !stay.checkedOutAt, reason };
    }).sort((left, right) => Number(right.suggested) - Number(left.suggested) || compareRoomNumbers(left.roomNumber, right.roomNumber));
  }

  async assignRoom(stayId: string, roomId: string) {
    return this.prisma.$transaction(async (tx) => {
      const stay = await tx.roomStay.findUnique({ where: { id: stayId } });
      if (!stay) throw new NotFoundException('Room stay not found');
      if (stay.cancelledAt) throw new ConflictException('This reservation is cancelled');
      if (stay.checkedOutAt) throw new ConflictException('This guest has already checked out');
      if (stay.roomId === roomId) {
        const current = await tx.roomStay.findUniqueOrThrow({ where: { id: stayId }, include: this.stayDetails() });
        return this.presentStay(current);
      }
      const lockIds = [...new Set([roomId, stay.roomId].filter((id): id is string => Boolean(id)))].sort();
      let destinationFound = false;
      for (const id of lockIds) {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Room" WHERE id = ${id} FOR UPDATE`;
        if (id === roomId) destinationFound = locked.length > 0;
      }
      if (!destinationFound) throw new NotFoundException('Room not found');
      const room = await tx.room.findUnique({ where: { id: roomId } });
      if (!room) throw new NotFoundException('Room not found');
      if (room.status === RoomStatus.MAINTENANCE || room.status === RoomStatus.ARCHIVED) throw new ConflictException('That room is not available');
      const clash = await tx.roomStay.count({ where: this.stayClashWhere(stay.checkedInAt, stay.expectedCheckoutAt, roomId, stayId) });
      if (clash) throw new ConflictException('That room is already booked for these dates');
      const claimed = await tx.roomStay.updateMany({ where: { id: stayId, roomId: stay.roomId, cancelledAt: null, checkedOutAt: null }, data: { roomId, assignmentReason: null } });
      if (!claimed.count) throw new ConflictException('This reservation changed before it could be assigned');
      const now = new Date();
      const inHouse = stay.checkedInAt.getTime() <= now.getTime();
      if (stay.roomId && inHouse) {
        const others = await tx.roomStay.count({ where: { roomId: stay.roomId, id: { not: stayId }, checkedOutAt: null, cancelledAt: null, checkedInAt: { lte: now } } });
        if (others === 0) await tx.room.updateMany({ where: { id: stay.roomId, status: RoomStatus.OCCUPIED }, data: { status: RoomStatus.AVAILABLE } });
      }
      if (inHouse) await tx.room.updateMany({ where: { id: roomId, status: RoomStatus.AVAILABLE }, data: { status: RoomStatus.OCCUPIED } });
      const result = await tx.roomStay.findUniqueOrThrow({ where: { id: stayId }, include: this.stayDetails() });
      return this.presentStay(result);
    });
  }

  private stayClashWhere(checkIn: Date, checkOut: Date | null, roomId: string, exceptStayId: string): Prisma.RoomStayWhereInput {
    return {
      roomId,
      id: { not: exceptStayId },
      cancelledAt: null,
      checkedOutAt: null,
      ...(checkOut ? { checkedInAt: { lt: checkOut } } : {}),
      OR: [{ expectedCheckoutAt: null }, { expectedCheckoutAt: { gt: checkIn } }],
    };
  }

  async updateStay(stayId: string, dto: UpdateRoomStayDto) {
    const stay = await this.prisma.roomStay.findUnique({ where: { id: stayId }, select: { id: true, checkedOutAt: true } });
    if (!stay) throw new NotFoundException('Room stay not found');
    if (stay.checkedOutAt) throw new ConflictException('Cannot edit a checked-out stay');
    const { occupants, expectedCheckoutAt, checkedInAt, chargeLimit, primaryGuestName, ...fields } = dto;
    if (checkedInAt && expectedCheckoutAt && new Date(expectedCheckoutAt).getTime() < new Date(checkedInAt).getTime()) throw new BadRequestException('Checkout must be on or after check-in');
    return this.prisma.roomStay.update({
      where: { id: stayId },
      data: {
        ...fields,
        ...(primaryGuestName !== undefined ? { primaryGuestName: primaryGuestName.trim() } : {}),
        ...(checkedInAt !== undefined ? { checkedInAt: new Date(checkedInAt) } : {}),
        ...(expectedCheckoutAt !== undefined ? { expectedCheckoutAt: expectedCheckoutAt ? new Date(expectedCheckoutAt) : null } : {}),
        ...(chargeLimit !== undefined ? { chargeLimit: chargeLimit === null ? null : new Prisma.Decimal(chargeLimit) } : {}),
        ...(occupants !== undefined ? { occupants: { deleteMany: {}, create: [...new Set(occupants.map((name) => name.trim()).filter(Boolean))].map((name) => ({ name })) } } : {}),
      },
      include: this.stayDetails(),
    }).then((stay) => this.presentStay(stay));
  }

  async timeline(stayId: string) {
    const stay = await this.prisma.roomStay.findUnique({ where: { id: stayId }, include: this.stayDetails() });
    if (!stay) throw new NotFoundException('Room stay not found');
    const grossTotal = stay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
    const folioTotal = stay.charges.filter((charge) => !charge.settledAt).reduce((sum, charge) => sum + Number(charge.amount), 0);
    const paidTotal = stay.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
    return this.presentStay({ ...stay, folioTotal, grossTotal, paidTotal, balanceDue: folioTotal });
  }

  async removeChargeLine(chargeId: string, dto: RemoveChargeLineDto) {
    const note = dto.reason.trim();
    if (!note) throw new BadRequestException('Say why this dish is removed');
    const charge = await this.prisma.roomCharge.findUnique({ where: { id: chargeId }, include: { order: { select: { vatPercent: true } } } });
    if (!charge) throw new NotFoundException('Bill not found');
    if (charge.settledAt) throw new ConflictException('This bill is already settled');
    if (charge.kind === RoomChargeKind.ROOM_FEE) throw new ConflictException('Room usage cannot be removed here');
    const lines = Array.isArray(charge.lines)
      ? charge.lines.flatMap((line) => (line && typeof line === 'object' && !Array.isArray(line) ? [{ ...(line as Record<string, unknown>) }] : []))
      : [];
    if (!lines.length) throw new BadRequestException('This bill has no dishes to edit');
    const index = lines.findIndex((line) => line.orderItemId === dto.orderItemId && Number(line.unit) === dto.unit && !line.removedAt);
    if (index < 0) throw new NotFoundException('Dish not found');
    const previousFood = moneyRound(lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0));
    const unitAmount = moneyRound(Number(lines[index].amount) || 0);
    const orderId = typeof lines[index].orderId === 'string' ? lines[index].orderId : charge.orderId;
    lines[index] = { ...lines[index], removedAt: new Date().toISOString(), removalReason: note };
    const food = moneyRound(lines.reduce((sum, line) => sum + (line.removedAt ? 0 : Number(line.amount) || 0), 0));
    const bill = charge.billId ? await this.prisma.tableBill.findUnique({ where: { id: charge.billId }, select: { vatPercent: true } }) : null;
    const declared = bill ? Number(bill.vatPercent) : Number(charge.order?.vatPercent ?? 0);
    const stored = Number(charge.amount);
    const implied = previousFood > 0 ? moneyRound(((stored - previousFood) / previousFood) * 100) : 0;
    const rate = Math.abs(exactTotalWithVat(previousFood, declared) - stored) < 0.05 || Math.abs(totalWithVat(previousFood, declared) - stored) < 0.05 ? declared : implied > 0 && implied <= 100 ? implied : declared;
    const charged = totalWithVat(food, rate);
    await this.prisma.$transaction(async (tx) => {
      await tx.roomCharge.update({ where: { id: charge.id }, data: { amount: charged, unitPrice: charged, lines: lines as Prisma.InputJsonValue } });
      if (!orderId) return;
      const item = await tx.orderItem.findUnique({ where: { id: dto.orderItemId } });
      if (!item || item.removedAt || item.orderId !== orderId) return;
      if (item.quantity <= 1) await tx.orderItem.update({ where: { id: item.id }, data: { removedAt: new Date(), removalReason: note } });
      else await tx.orderItem.update({ where: { id: item.id }, data: { quantity: item.quantity - 1, subtotal: moneyRound(Math.max(0, Number(item.subtotal) - unitAmount)) } });
      const siblings = await tx.orderItem.findMany({ where: { orderId }, select: { subtotal: true, removedAt: true } });
      const total = moneyRound(siblings.reduce((sum, entry) => sum + (entry.removedAt ? 0 : Number(entry.subtotal)), 0));
      await tx.order.update({ where: { id: orderId }, data: { totalAmount: total } });
    });
    return this.timeline(charge.stayId);
  }

  async updateChargeLineQuantity(chargeId: string, dto: { orderItemId: string; unit: number; quantity: number }) {
    const charge = await this.prisma.roomCharge.findUnique({ where: { id: chargeId }, include: { order: { select: { vatPercent: true } } } });
    if (!charge) throw new NotFoundException('Bill not found');
    if (charge.settledAt) throw new ConflictException('This bill is already settled');
    if (charge.kind === RoomChargeKind.ROOM_FEE) throw new ConflictException('Room usage cannot be changed here');
    const lines = Array.isArray(charge.lines)
      ? charge.lines.flatMap((line) => (line && typeof line === 'object' && !Array.isArray(line) ? [{ ...(line as Record<string, unknown>) }] : []))
      : [];
    const index = lines.findIndex((line) => line.orderItemId === dto.orderItemId && Number(line.unit) === dto.unit && !line.removedAt);
    if (index < 0) throw new NotFoundException('Dish not found');
    const previousQty = Math.max(1, Math.round(Number(lines[index].quantity) || 1));
    if (previousQty === dto.quantity) return this.timeline(charge.stayId);
    const previousAmount = moneyRound(Number(lines[index].amount) || 0);
    const nextAmount = moneyRound((previousAmount / previousQty) * dto.quantity);
    lines[index] = { ...lines[index], quantity: dto.quantity, amount: nextAmount };
    const previousFood = moneyRound(lines.reduce((sum, line) => sum + (line === lines[index] ? previousAmount : (Number(line.amount) || 0)), 0));
    const food = moneyRound(lines.reduce((sum, line) => sum + (line.removedAt ? 0 : Number(line.amount) || 0), 0));
    const bill = charge.billId ? await this.prisma.tableBill.findUnique({ where: { id: charge.billId }, select: { vatPercent: true } }) : null;
    const declared = bill ? Number(bill.vatPercent) : Number(charge.order?.vatPercent ?? 0);
    const stored = Number(charge.amount);
    const implied = previousFood > 0 ? moneyRound(((stored - previousFood) / previousFood) * 100) : 0;
    const rate = Math.abs(exactTotalWithVat(previousFood, declared) - stored) < 0.05 || Math.abs(totalWithVat(previousFood, declared) - stored) < 0.05 ? declared : implied > 0 && implied <= 100 ? implied : declared;
    const charged = totalWithVat(food, rate);
    await this.guardChargeLimit(charge.stayId, charge.id, charged);
    const orderId = typeof lines[index].orderId === 'string' ? lines[index].orderId : charge.orderId;
    await this.prisma.$transaction(async (tx) => {
      await tx.roomCharge.update({ where: { id: charge.id }, data: { amount: charged, unitPrice: charged, lines: lines as Prisma.InputJsonValue } });
      if (!orderId) return;
      const item = await tx.orderItem.findUnique({ where: { id: dto.orderItemId } });
      if (!item || item.removedAt || item.orderId !== orderId) return;
      const nextQty = Math.max(1, item.quantity + (dto.quantity - previousQty));
      const subtotal = moneyRound(Math.max(0, Number(item.subtotal) + (nextAmount - previousAmount)));
      await tx.orderItem.update({ where: { id: item.id }, data: { quantity: nextQty, subtotal } });
      await this.syncOrderTotal(tx, orderId, item.id, nextQty);
    });
    return this.timeline(charge.stayId);
  }

  async updateChargedItemQuantity(chargeId: string, itemId: string, quantity: number) {
    const charge = await this.prisma.roomCharge.findUnique({ where: { id: chargeId }, include: { order: { select: { id: true, vatPercent: true, paymentStatus: true } } } });
    if (!charge) throw new NotFoundException('Bill not found');
    if (charge.settledAt) throw new ConflictException('This bill is already settled');
    if (!charge.orderId || charge.orderId !== charge.order?.id) throw new NotFoundException('Dish not found');
    if (Array.isArray(charge.lines) && charge.lines.length) throw new BadRequestException('Change this dish from its line');
    const item = await this.prisma.orderItem.findUnique({ where: { id: itemId } });
    if (!item || item.orderId !== charge.orderId) throw new NotFoundException('Dish not found');
    if (item.removedAt) throw new ConflictException('This dish is already removed');
    const previousQty = Math.max(1, item.quantity);
    if (previousQty === quantity) return this.timeline(charge.stayId);
    const subtotal = moneyRound((Number(item.subtotal) / previousQty) * quantity);
    const siblings = await this.prisma.orderItem.findMany({ where: { orderId: charge.orderId }, select: { id: true, quantity: true, subtotal: true, removedAt: true, itemSnapshot: true } });
    const food = moneyRound(siblings.reduce((sum, entry) => sum + (entry.removedAt ? 0 : entry.id === item.id ? subtotal : Number(entry.subtotal)), 0));
    const charged = totalWithVat(food, Number(charge.order.vatPercent));
    await this.guardChargeLimit(charge.stayId, charge.id, charged);
    const labels = siblings.flatMap((entry) => {
      if (entry.removedAt) return [];
      const copy = entry.itemSnapshot && typeof entry.itemSnapshot === 'object' && !Array.isArray(entry.itemSnapshot) ? entry.itemSnapshot as { name?: string } : {};
      return [`${entry.id === item.id ? quantity : entry.quantity}× ${copy.name || 'item'}`];
    });
    const prefix = charge.description.includes(':') ? charge.description.slice(0, charge.description.indexOf(':')) : 'Room service';
    await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.update({ where: { id: item.id }, data: { quantity, subtotal } });
      await tx.order.update({ where: { id: charge.orderId! }, data: { totalAmount: food } });
      await tx.roomCharge.update({ where: { id: charge.id }, data: { amount: charged, unitPrice: charged, description: `${prefix}: ${labels.join(', ')}` } });
      await this.syncTicketQuantity(tx, charge.orderId!, item.itemSnapshot, quantity);
    });
    return this.timeline(charge.stayId);
  }

  async signCharge(chargeId: string, dto: SignRoomChargeDto) {
    const signedByName = dto.signedByName.trim();
    const signatureData = dto.signatureData.trim();
    if (!signedByName || !signatureData) throw new BadRequestException('A guest name and signature are required');
    const charge = await this.prisma.roomCharge.findUnique({ where: { id: chargeId }, select: { id: true, stayId: true, billId: true } });
    if (!charge) throw new NotFoundException('Bill not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.roomCharge.update({ where: { id: charge.id }, data: { signedByName, signatureData } });
      if (charge.billId) await tx.tableBill.updateMany({ where: { id: charge.billId }, data: { signedByName, signatureData } });
    });
    return this.timeline(charge.stayId);
  }

  async updateChargeQuantity(chargeId: string, quantity: number) {
    const charge = await this.prisma.roomCharge.findUnique({ where: { id: chargeId }, include: { commissionItem: true } });
    if (!charge) throw new NotFoundException('Bill not found');
    if (charge.settledAt) throw new ConflictException('This bill is already settled');
    if (charge.orderId || (Array.isArray(charge.lines) && charge.lines.length)) throw new BadRequestException('Change this dish from its line');
    if (charge.kind === RoomChargeKind.ROOM_FEE) throw new ConflictException('Room usage cannot be changed here');
    const amount = new Prisma.Decimal(charge.unitPrice).mul(quantity);
    await this.guardChargeLimit(charge.stayId, charge.id, Number(amount));
    const commissionAmount = charge.commissionItem ? new Prisma.Decimal(charge.commissionItem.commission).mul(quantity) : undefined;
    await this.prisma.roomCharge.update({ where: { id: charge.id }, data: { quantity, amount, ...(commissionAmount ? { commissionAmount } : {}) } });
    return this.timeline(charge.stayId);
  }

  private async guardChargeLimit(stayId: string, chargeId: string, nextAmount: number) {
    const stay = await this.prisma.roomStay.findUnique({ where: { id: stayId }, select: { chargeLimit: true, charges: { where: { settledAt: null, kind: { not: RoomChargeKind.ROOM_FEE } }, select: { id: true, amount: true } } } });
    if (!stay?.chargeLimit) return;
    const open = stay.charges.reduce((sum, entry) => sum + (entry.id === chargeId ? nextAmount : Number(entry.amount)), 0);
    if (open > Number(stay.chargeLimit)) throw new ConflictException('This guest stay charge limit would be exceeded');
  }

  private async syncOrderTotal(tx: Prisma.TransactionClient, orderId: string, itemId: string, quantity: number) {
    const siblings = await tx.orderItem.findMany({ where: { orderId }, select: { subtotal: true, removedAt: true } });
    const total = moneyRound(siblings.reduce((sum, entry) => sum + (entry.removedAt ? 0 : Number(entry.subtotal)), 0));
    await tx.order.update({ where: { id: orderId }, data: { totalAmount: total } });
    const item = await tx.orderItem.findUnique({ where: { id: itemId }, select: { itemSnapshot: true } });
    await this.syncTicketQuantity(tx, orderId, item?.itemSnapshot, quantity);
  }

  private async syncTicketQuantity(tx: Prisma.TransactionClient, orderId: string, snapshot: unknown, quantity: number) {
    const copy = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot as { lineIndex?: number } : {};
    if (typeof copy.lineIndex !== 'number') return;
    const tickets = await tx.orderPrepTicket.findMany({ where: { orderId }, select: { id: true, items: true } });
    for (const ticket of tickets) {
      const lines = Array.isArray(ticket.items) ? ticket.items.flatMap((line) => (line && typeof line === 'object' && !Array.isArray(line) ? [{ ...(line as Record<string, unknown>) }] : [])) : [];
      let changed = false;
      const next = lines.map((line) => {
        if (Number(line.lineIndex) !== copy.lineIndex) return line;
        changed = true;
        return { ...line, quantity };
      });
      if (changed) await tx.orderPrepTicket.update({ where: { id: ticket.id }, data: { items: next as Prisma.InputJsonValue } });
    }
  }

  async settle(stayId: string, receivedById: string, dto: SettleRoomStayDto) {
    try {
    return await this.prisma.$transaction(async (tx) => {
      const prior = await this.idempotency.read(tx, 'room.settle', dto.clientRequestId);
      if (prior) return prior;
      const setting = await tx.restaurantSetting.findUnique({ where: { id: 'restaurant' }, select: { vatPercent: true } });
      const stay = await tx.roomStay.findUnique({ where: { id: stayId }, include: { charges: { where: { settledAt: null, kind: { not: RoomChargeKind.ROOM_FEE } }, select: { id: true, orderId: true, amount: true, kind: true, lines: true, order: { select: { vatPercent: true, items: { select: { subtotal: true, unitPrice: true, quantity: true, removedAt: true } } } } } } } });
      if (!stay) throw new NotFoundException('Room stay not found');
      if (stay.checkedOutAt) throw new ConflictException('Cannot settle a checked-out stay');
      const requestedIds = dto.chargeIds ? [...new Set(dto.chargeIds)] : null;
      const charges = requestedIds ? stay.charges.filter((charge) => requestedIds.includes(charge.id)) : stay.charges;
      if (requestedIds && charges.length !== requestedIds.length) throw new ConflictException('One or more bills are already settled or do not belong to this stay');
      const amount = folioPayable(charges, Number(setting?.vatPercent ?? 0));
      if (amount <= 0) throw new ConflictException('There is no open room tab to settle');
      const now = new Date();
      await tx.roomPayment.create({ data: { stayId, amount: new Prisma.Decimal(amount), method: dto.method, note: dto.note?.trim() || null, receivedById } });
      await tx.roomCharge.updateMany({ where: { id: { in: charges.map((charge) => charge.id) } }, data: { settledAt: now } });
      const orderIds = charges.flatMap((charge) => charge.orderId ? [charge.orderId] : []);
      if (orderIds.length) await tx.order.updateMany({ where: { id: { in: orderIds }, paymentStatus: OrderPaymentStatus.ROOM_FOLIO }, data: { paymentMethod: dto.method === RoomPaymentMethod.CARD ? 'CARD' : 'CASH', paymentStatus: OrderPaymentStatus.PAID, paidAt: now, paidById: receivedById } });
      const result = await tx.roomStay.findUniqueOrThrow({ where: { id: stayId }, include: this.stayDetails() });
      const openTotal = result.charges.filter((charge) => !charge.settledAt).reduce((sum, charge) => sum + Number(charge.amount), 0);
      const paidTotal = result.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
      const grossTotal = result.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      const settled = this.presentStay({ ...result, folioTotal: openTotal, grossTotal, paidTotal, balanceDue: openTotal });
      await this.idempotency.write(tx, 'room.settle', dto.clientRequestId, receivedById, settled);
      return settled;
    });
    } catch (error) {
      const saved = await this.idempotency.recover(error, 'room.settle', dto.clientRequestId);
      if (saved) return saved;
      throw error;
    }
  }

  async history(roomId: string) {
    await this.findRoom(roomId);
    const stays = await this.prisma.roomStay.findMany({
      where: { roomId },
      orderBy: { checkedInAt: 'desc' },
      include: this.stayDetails(),
    });
    return stays.map((stay) => this.presentStay(stay));
  }

  async checkOut(stayId: string) {
    return this.prisma.$transaction(async (tx) => {
      const stay = await tx.roomStay.findUnique({ where: { id: stayId }, include: { room: true, charges: { where: { settledAt: null, kind: { not: RoomChargeKind.ROOM_FEE } }, select: { amount: true } } } });
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
      if (stay.roomId) {
        const currentStay = await tx.roomStay.count({ where: { roomId: stay.roomId, checkedOutAt: null, cancelledAt: null } });
        if (currentStay === 0) await tx.room.update({ where: { id: stay.roomId }, data: { status: RoomStatus.AVAILABLE } });
      }
      const result = await tx.roomStay.findUniqueOrThrow({ where: { id: stayId }, include: this.stayDetails() });
      const grossTotal = result.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      const paidTotal = result.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
      return this.presentStay({ ...result, folioTotal: result.charges.filter((charge) => !charge.settledAt).reduce((sum, charge) => sum + Number(charge.amount), 0), grossTotal, paidTotal, balanceDue: result.charges.filter((charge) => !charge.settledAt).reduce((sum, charge) => sum + Number(charge.amount), 0) });
    });
  }

  private appendNote(current: string | null, line: string) {
    return current?.includes(line) ? current : `${current ? `${current} ` : ''}${line}`;
  }

  private async findRoom(id: string) {
    const room = await this.prisma.room.findUnique({ where: { id } });
    if (!room) throw new NotFoundException('Room not found');
    return room;
  }

  private presentStay<T extends { orders?: unknown[] | null; charges?: { kind: string; amount: Prisma.Decimal | number | string; settledAt?: Date | null }[] | null }>(stay: T): T {
    if (!Array.isArray(stay.charges)) {
      if (!stay.orders) return stay;
      return { ...stay, orders: stay.orders.map((order) => presentOrder(order)) };
    }
    const charges = stay.charges.filter((charge) => charge.kind !== RoomChargeKind.ROOM_FEE);
    const open = charges.filter((charge) => !charge.settledAt).reduce((sum, charge) => sum + Number(charge.amount), 0);
    const next = { ...stay, charges, grossTotal: charges.reduce((sum, charge) => sum + Number(charge.amount), 0), folioTotal: open, balanceDue: open };
    if (!next.orders) return next;
    return { ...next, orders: next.orders.map((order) => presentOrder(order)) };
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

