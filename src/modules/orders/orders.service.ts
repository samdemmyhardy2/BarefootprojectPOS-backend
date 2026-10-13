import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import { PrismaService } from 'src/utils/prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { TableStatus } from 'prisma/generated/prisma/enums';
import { OrderPaymentMethod, OrderStatus } from 'prisma/generated/prisma/enums';

@Injectable()
export class OrdersService {
  private readonly orderEvents = new Subject<{ type: 'created' | 'updated' | 'deleted'; order: object | string }>();
  constructor(private readonly prisma: PrismaService) { }

  events() { return this.orderEvents.asObservable(); }

  liveSnapshot() {
    return this.prisma.order.findMany({
      where: { status: { in: [OrderStatus.PENDING, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.SERVED] } },
      orderBy: { createdAt: 'asc' },
      include: this.orderDetails(),
    });
  }

  async create(waiterId: string, dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException(
        'Order must contain at least one item',
      );
    }

    if (!dto.tableId && !dto.roomStayId) throw new BadRequestException('Select a restaurant table or an active guest room');
    const paymentMethod = dto.paymentMethod ?? OrderPaymentMethod.CASH;
    if (paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && !dto.roomStayId) throw new BadRequestException('Choose an active room stay to charge at checkout');
    const table = dto.tableId ? await this.prisma.table.findUnique({ where: { id: dto.tableId } }) : null;
    if (dto.tableId && !table) throw new NotFoundException('Table not found');
    const roomStay = dto.roomStayId ? await this.prisma.roomStay.findUnique({ where: { id: dto.roomStayId }, include: { room: true } }) : null;
    if (dto.roomStayId && !roomStay) throw new NotFoundException('Room stay not found');
    if (roomStay?.checkedOutAt) throw new ConflictException('Cannot add an order to a checked-out room');

    // Get all menu items.
    const menuItemIds = dto.items.map(
      (item) => item.menuItemId,
    );

    const menuItems = await this.prisma.menuItem.findMany({
      where: {
        id: {
          in: menuItemIds,
        },
      },
    });

    if (menuItems.length !== menuItemIds.length) {
      throw new NotFoundException(
        'One or more menu items were not found',
      );
    }

    const priceMap = new Map<string, number>(
      menuItems.map((item) => [
        item.id,
        Number(item.price),
      ]),
    );

    let totalAmount = 0;

    const orderItemsData = dto.items.map((item) => {
      const unitPrice = priceMap.get(item.menuItemId);

      if (unitPrice === undefined) {
        throw new NotFoundException(
          `Menu item ${item.menuItemId} not found`,
        );
      }

      const subtotal = unitPrice * item.quantity;

      totalAmount += subtotal;

      return {
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        unitPrice,
        subtotal,
        removeIngredients:
          item.removeIngredients || null,
        addExtras: item.addExtras || null,
        specialNotes:
          item.specialNotes || null,
      };
    });

    const order = await this.prisma.$transaction(async (tx) => {
      if (dto.roomStayId) {
        // A conditional no-op update locks the stay row so a concurrent
        // checkout cannot close it between validation and order creation.
        const activeStay = await tx.roomStay.updateMany({ where: { id: dto.roomStayId, checkedOutAt: null }, data: { checkedOutAt: null } });
        if (!activeStay.count) throw new ConflictException('Room stay is closed; select a current guest');
      }
      // OCCUPIED tables may receive additional tickets. Claim the table only
      // when it was free/reserved, while still handling concurrent first orders.
      if (table && table.status !== TableStatus.OCCUPIED) {
        const tableClaim = await tx.table.updateMany({ where: { id: table.id, status: table.status }, data: { status: TableStatus.OCCUPIED } });
        if (!tableClaim.count) throw new ConflictException('Table status changed; refresh and retry');
      }
      const created = await tx.order.create({
        data: {
          tableId: dto.tableId ?? null,
          roomStayId: dto.roomStayId ?? null,
          paymentMethod,
          waiterId,
          totalAmount,
          items: {
            create: orderItemsData,
          },
        },
        include: {
          items: {
            include: {
              menuItem: true,
            },
          },
          table: true,
          waiter: { select: { id: true, name: true, email: true } },
          roomStay: { include: { room: true } },
        },
      });
      if (paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && dto.roomStayId) {
        const summary = dto.items.map((line) => `${line.quantity}× ${menuItems.find((item) => item.id === line.menuItemId)?.name ?? 'item'}`).join(', ');
        await tx.roomCharge.create({ data: { stayId: dto.roomStayId, orderId: created.id, kind: 'RESTAURANT_ORDER', description: `Restaurant order: ${summary}`, quantity: 1, unitPrice: totalAmount, amount: totalAmount } });
      }
      return created;
    });
    this.orderEvents.next({ type: 'created', order });
    return order;
  }

  async findAll() {
    return this.prisma.order.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        items: {
          include: {
            menuItem: true,
          },
        },
        table: true,
        roomStay: { include: { room: true } },
        waiter: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: {
        id,
      },
      include: {
        items: {
          include: {
            menuItem: true,
          },
        },
        table: true,
        roomStay: { include: { room: true } },
        waiter: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException(
        `Order #${id} not found`,
      );
    }

    return order;
  }

  async updateStatus(
    id: string,
    dto: UpdateOrderStatusDto,
  ) {
    const order = await this.prisma.order.findUnique({
      where: {
        id,
      },
    });

    if (!order) {
      throw new NotFoundException(
        `Order #${id} not found`,
      );
    }

    const updatedOrder = await this.setStatus(order, dto.status);
    this.orderEvents.next({ type: 'updated', order: updatedOrder });
    return updatedOrder;
  }

  async cookQueue() {
    return this.prisma.order.findMany({ where: { status: { in: [OrderStatus.PENDING, OrderStatus.PREPARING] } }, orderBy: { createdAt: 'asc' }, include: this.orderDetails() });
  }

  async readyOrders() {
    return this.prisma.order.findMany({ where: { status: OrderStatus.READY }, orderBy: { updatedAt: 'asc' }, include: this.orderDetails() });
  }

  async cookStart(id: string) { return this.transition(id, OrderStatus.PENDING, OrderStatus.PREPARING); }
  async cookReady(id: string) { return this.transition(id, OrderStatus.PREPARING, OrderStatus.READY); }
  async acknowledgeReady(id: string) { return this.transition(id, OrderStatus.READY, OrderStatus.SERVED); }

  async remove(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { roomCharge: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.roomCharge) throw new ConflictException('A room-checkout order is part of a guest folio and cannot be deleted');
    await this.prisma.$transaction(async (tx) => {
      await tx.order.delete({ where: { id } });
      if (order.tableId) {
        const activeOrders = await tx.order.count({ where: { tableId: order.tableId, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } } });
        if (activeOrders === 0) await tx.table.update({ where: { id: order.tableId }, data: { status: TableStatus.AVAILABLE } });
      }
    });
    this.orderEvents.next({ type: 'deleted', order: { id } });
    return { id, deleted: true };
  }

  private async transition(id: string, from: OrderStatus, to: OrderStatus) {
    const changed = await this.prisma.order.updateMany({ where: { id, status: from }, data: { status: to } });
    if (!changed.count) {
      const order = await this.prisma.order.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!order) throw new NotFoundException('Order not found');
      throw new ConflictException(`Order must be ${from} before it can become ${to}`);
    }
    const updated = await this.prisma.order.findUniqueOrThrow({ where: { id }, include: this.orderDetails() });
    if (to === OrderStatus.COMPLETED || to === OrderStatus.CANCELLED) {
      // The cook flow never reaches a terminal state; this maintains the table invariant if reused.
      if (updated.tableId) {
        const activeOrders = await this.prisma.order.count({ where: { tableId: updated.tableId, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } } });
        if (activeOrders === 0) await this.prisma.table.update({ where: { id: updated.tableId }, data: { status: TableStatus.AVAILABLE } });
      }
    }
    this.orderEvents.next({ type: 'updated', order: updated });
    return updated;
  }

  private async setStatus(order: { id: string; tableId: string | null }, status: OrderStatus) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({ where: { id: order.id }, data: { status }, include: this.orderDetails() });
      if ((status === OrderStatus.COMPLETED || status === OrderStatus.CANCELLED) && order.tableId) {
        const activeOrders = await tx.order.count({ where: { tableId: order.tableId, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } } });
        if (activeOrders === 0) await tx.table.update({ where: { id: order.tableId }, data: { status: TableStatus.AVAILABLE } });
      }
      return updated;
    });
  }

  private orderDetails() {
    return { items: { include: { menuItem: true } }, table: true, roomStay: { include: { room: true } }, waiter: { select: { id: true, name: true } } };
  }
}
