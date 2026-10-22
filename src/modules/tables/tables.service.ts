import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { UpdateTableStatusDto } from './dto/update-table-status.dto';
import { CheckoutTableDto } from './dto/checkout-table.dto';
import { OrderPaymentMethod, OrderPaymentStatus, OrderStatus, TableShape, TableStatus } from 'prisma/generated/prisma/enums';
import { UpdateTableLayoutDto } from './dto/update-table-layout.dto';

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
  findAll() { return this.prisma.table.findMany({ orderBy: { tableNumber: 'asc' } }); }
  async findOne(id: string) { const table = await this.prisma.table.findUnique({ where: { id } }); if (!table) throw new NotFoundException('Table not found'); return table; }
  async create(dto: CreateTableDto) {
    const existing = await this.prisma.table.findMany({ select: { positionX: true, positionY: true, width: true, height: true } });
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
    return this.prisma.table.update({ where: { id }, data: { status: dto.status } });
  }
  async updateLayout(dto: UpdateTableLayoutDto) {
    const current = await this.prisma.table.findMany({ select: { id: true } });
    const currentIds = new Set(current.map((table) => table.id));
    const submittedIds = new Set(dto.tables.map((table) => table.id));
    if (dto.tables.length !== current.length || submittedIds.size !== dto.tables.length || dto.tables.some((table) => !currentIds.has(table.id))) {
      throw new BadRequestException('Layout must include every existing table exactly once');
    }
    const slots = new Set<string>();
    for (const table of dto.tables) {
      const span = tableSpan(table);
      const tableSlots = occupiedSlots(table.positionX, table.positionY, span.columns, span.rows);
      if (table.positionX + span.columns > 12) throw new BadRequestException('A table shape extends beyond the floor boundary');
      if (tableSlots.some((slot) => slots.has(slot))) throw new BadRequestException('Table shapes cannot overlap on the floor');
      tableSlots.forEach((slot) => slots.add(slot));
    }
    return this.prisma.$transaction(async (tx) => {
      await Promise.all(dto.tables.map((table) => tx.table.update({
        where: { id: table.id },
        data: { positionX: table.positionX, positionY: table.positionY, width: table.width, height: table.height, shape: table.shape },
      })));
      return tx.table.findMany({ orderBy: [{ positionY: 'asc' }, { positionX: 'asc' }] });
    });
  }
  async checkout(id: string, cashierId: string, dto: CheckoutTableDto) {
    if (dto.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && !dto.roomStayId) {
      throw new ConflictException('Choose the guest room to charge this bill to the room folio');
    }
    if (dto.paymentMethod === OrderPaymentMethod.CASH && dto.roomStayId) {
      throw new ConflictException('A room can only be selected when charging to the room folio');
    }
    return this.prisma.$transaction(async (tx) => {
      const table = await tx.table.findUnique({ where: { id } });
      if (!table) throw new NotFoundException('Table not found');
      const orders = await tx.order.findMany({
        where: { tableId: id, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } },
        include: { items: { include: { menuItem: true } } },
        orderBy: { createdAt: 'asc' },
      });
      if (!orders.length) throw new ConflictException('This table has no open orders to check out');
      if (orders.some((order) => order.status !== OrderStatus.SERVED)) {
        throw new ConflictException('All table orders must be served before checkout');
      }

      let stay: { id: string; room: { roomNumber: number } } | null = null;
      if (dto.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && dto.roomStayId) {
        const active = await tx.roomStay.updateMany({ where: { id: dto.roomStayId, checkedOutAt: null }, data: { checkedOutAt: null } });
        if (!active.count) throw new ConflictException('The selected guest stay is no longer active');
        stay = await tx.roomStay.findUnique({ where: { id: dto.roomStayId }, select: { id: true, room: { select: { roomNumber: true } } } });
        if (!stay) throw new NotFoundException('Room stay not found');
      }

      const now = new Date();
      const totalAmount = orders.reduce((sum, order) => sum + Number(order.totalAmount), 0);
      for (const order of orders) {
        if (dto.paymentMethod === OrderPaymentMethod.CASH) {
          if (order.paymentStatus === OrderPaymentStatus.ROOM_FOLIO) {
            throw new ConflictException('An order already charged to a room folio cannot be paid in cash again');
          }
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.COMPLETED, paymentMethod: OrderPaymentMethod.CASH, paymentStatus: OrderPaymentStatus.PAID, paidAt: order.paidAt ?? now, paidById: cashierId },
          });
        } else {
          if (order.paymentStatus === OrderPaymentStatus.PAID) {
            throw new ConflictException('An order already paid in cash cannot be charged to a room folio');
          }
          if (order.roomStayId && order.roomStayId !== dto.roomStayId) {
            throw new ConflictException('The table includes an order already linked to another guest room');
          }
          if (order.paymentStatus === OrderPaymentStatus.UNPAID) {
            const summary = order.items.map((line) => `${line.quantity}× ${line.menuItem.name}`).join(', ');
            await tx.roomCharge.create({
              data: { stayId: dto.roomStayId!, orderId: order.id, kind: 'RESTAURANT_ORDER', description: `Table ${table.tableNumber} restaurant order: ${summary}`, quantity: 1, unitPrice: Number(order.totalAmount), amount: Number(order.totalAmount) },
            });
          }
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.COMPLETED, paymentMethod: OrderPaymentMethod.ROOM_CHECKOUT, paymentStatus: OrderPaymentStatus.ROOM_FOLIO, roomStayId: dto.roomStayId },
          });
        }
      }
      await tx.table.update({ where: { id }, data: { status: TableStatus.AVAILABLE } });
      return { tableId: id, tableNumber: table.tableNumber, paymentMethod: dto.paymentMethod, room: stay?.room ?? null, totalAmount, orderIds: orders.map((order) => order.id), checkedOutAt: now };
    });
  }
  async remove(id: string) {
    await this.findOne(id);
    const orders = await this.prisma.order.count({ where: { tableId: id } });
    if (orders) throw new ConflictException('A table with order history cannot be deleted');
    return this.prisma.table.delete({ where: { id } });
  }
}
