import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { UpdateTableStatusDto } from './dto/update-table-status.dto';
import { CheckoutTableDto } from './dto/checkout-table.dto';
import { OrderPaymentMethod, OrderPaymentStatus, OrderStatus, TableStatus } from 'prisma/generated/prisma/enums';

@Injectable()
export class TablesService {
  constructor(private readonly prisma: PrismaService) {}
  findAll() { return this.prisma.table.findMany({ orderBy: { tableNumber: 'asc' } }); }
  async findOne(id: string) { const table = await this.prisma.table.findUnique({ where: { id } }); if (!table) throw new NotFoundException('Table not found'); return table; }
  async create(dto: CreateTableDto) {
    try { return await this.prisma.table.create({ data: dto }); }
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
