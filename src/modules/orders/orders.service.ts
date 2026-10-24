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
import { OrderPaymentMethod, OrderPaymentStatus, OrderStatus, OrderType } from 'prisma/generated/prisma/enums';
import { OrderPageQueryDto } from './dto/order-page-query.dto';

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
    const creator = await this.prisma.user.findUnique({ where: { id: waiterId }, select: { role: true, jobTitle: true } });
    if (!creator) throw new NotFoundException('Order creator was not found');
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException(
        'Order must contain at least one item',
      );
    }

    const orderType = dto.type ?? (dto.tableId ? OrderType.DINE_IN : dto.roomStayId ? OrderType.ROOM_SERVICE : OrderType.PICKUP);
    if (orderType === OrderType.DINE_IN && !dto.tableId) throw new BadRequestException('Select a restaurant table for a dine-in order');
    if (orderType === OrderType.ROOM_SERVICE && (!dto.roomStayId || dto.tableId)) throw new BadRequestException('Select an active guest room for room service');
    if (orderType === OrderType.PICKUP && (dto.tableId || dto.roomStayId)) throw new BadRequestException('Pickup orders cannot be attached to a table or room');
    const jobTitle = creator.jobTitle.trim().toLowerCase().replace(/[^a-z]/g, '');
    if (orderType === OrderType.PICKUP) {
      if (creator.role !== 'ADMIN' && !['waiter', 'guestwelcomer', 'bungalowmanager'].includes(jobTitle)) {
        throw new BadRequestException('Your job role cannot create pickup orders');
      }
      if (!dto.customerName?.trim()) throw new BadRequestException('Enter the customer name for a pickup order');
    }
    const paymentMethod = dto.paymentMethod ?? OrderPaymentMethod.CASH;
    if (dto.tableId && dto.roomStayId && paymentMethod !== OrderPaymentMethod.ROOM_CHECKOUT) {
      throw new BadRequestException('A restaurant table can only be linked to a room when charging the order to the guest folio');
    }
    if (dto.tableId && creator.role !== 'ADMIN' && creator.jobTitle.trim().toLowerCase() !== 'waiter') {
      throw new BadRequestException('Your job role cannot place orders for restaurant tables');
    }
    const waiterTableCheckout = Boolean(dto.tableId)
      && paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT
      && jobTitle === 'waiter';
    if (dto.roomStayId && creator.role !== 'ADMIN' && !waiterTableCheckout && !['guestwelcomer', 'bungalowmanager'].includes(jobTitle)) {
      throw new BadRequestException('Your job role cannot place orders against guest room stays');
    }
    if (paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && !dto.roomStayId) throw new BadRequestException('Choose an active room stay to charge at checkout');
    const table = dto.tableId ? await this.prisma.table.findUnique({ where: { id: dto.tableId } }) : null;
    if (dto.tableId && !table) throw new NotFoundException('Table not found');
    const roomStay = dto.roomStayId ? await this.prisma.roomStay.findUnique({ where: { id: dto.roomStayId }, include: { room: true } }) : null;
    if (dto.roomStayId && !roomStay) throw new NotFoundException('Room stay not found');
    if (roomStay?.checkedOutAt) throw new ConflictException('Cannot add an order to a checked-out room');

    // Get all menu items.
    // Each order line is intentionally separate so each serving can carry its
    // own allergens, removals, extras, and kitchen notes. Fetch distinct menu
    // records once, then validate against the number of distinct IDs.
    const menuItemIds = [...new Set(dto.items.map((item) => item.menuItemId))];

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

      const menuItem = menuItems.find((candidate) => candidate.id === item.menuItemId);
      const validAllergens = new Set(menuItem?.allergens ?? []);
      if (item.selectedAllergens?.some((allergen) => !validAllergens.has(allergen))) {
        throw new BadRequestException('Selected allergens must match the allergens configured for the menu item');
      }

      totalAmount += subtotal;

      return {
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        unitPrice,
        subtotal,
        removeIngredients:
          item.removeIngredients || null,
        addExtras: item.addExtras || null,
        selectedAllergens: item.selectedAllergens ?? [],
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
          type: orderType,
          customerName: orderType === OrderType.PICKUP ? dto.customerName!.trim() : null,
          customerPhone: orderType === OrderType.PICKUP ? dto.customerPhone?.trim() || null : null,
          tableId: dto.tableId ?? null,
          roomStayId: dto.roomStayId ?? null,
          paymentMethod,
          paymentStatus: paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT ? OrderPaymentStatus.ROOM_FOLIO : OrderPaymentStatus.UNPAID,
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

  activeRoomStays() {
    return this.prisma.roomStay.findMany({
      where: { checkedOutAt: null, room: { status: 'OCCUPIED' } },
      select: { id: true, primaryGuestName: true, room: { select: { roomNumber: true } } },
      orderBy: { checkedInAt: 'desc' },
    });
  }

  async findAll() {
    return this.prisma.order.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      include: this.orderDetails(),
    });
  }

  async findPage(query: OrderPageQueryDto) {
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 10;
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from >= to) throw new BadRequestException('The start of the date range must be before its end');
    const where = from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {};
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit, include: this.orderDetails() }),
      this.prisma.order.count({ where }),
    ]);
    return { items, total, offset, limit, hasMore: offset + items.length < total };
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: {
        id,
      },
      include: this.orderDetails(),
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
    actorId: string,
  ) {
    const order = await this.prisma.order.findUnique({
      where: {
        id,
      },
      select: { id: true, tableId: true, status: true, preparingAt: true, readyAt: true, servedAt: true },
    });

    if (!order) {
      throw new NotFoundException(
        `Order #${id} not found`,
      );
    }

    const updatedOrder = await this.setStatus(order, dto.status, actorId);
    this.orderEvents.next({ type: 'updated', order: updatedOrder });
    return updatedOrder;
  }

  async cookQueue() {
    return this.prisma.order.findMany({ where: { status: { in: [OrderStatus.PENDING, OrderStatus.PREPARING] } }, orderBy: { createdAt: 'asc' }, include: this.orderDetails() });
  }

  async readyOrders() {
    return this.prisma.order.findMany({ where: { status: OrderStatus.READY, type: { not: OrderType.PICKUP } }, orderBy: { readyAt: 'asc' }, include: this.orderDetails() });
  }

  async pickupOrders() {
    return this.prisma.order.findMany({
      where: { type: OrderType.PICKUP, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } },
      orderBy: { createdAt: 'asc' },
      include: this.orderDetails(),
    });
  }

  async completePickup(id: string, employeeId: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, select: { id: true, type: true, status: true } });
    if (!order) throw new NotFoundException('Pickup order not found');
    if (order.type !== OrderType.PICKUP) throw new BadRequestException('This order is not a pickup order');
    if (order.status !== OrderStatus.READY) throw new ConflictException('Pickup order must be ready before it can be collected');
    const now = new Date();
    const claim = await this.prisma.order.updateMany({
      where: { id, type: OrderType.PICKUP, status: OrderStatus.READY },
      data: { status: OrderStatus.COMPLETED, paymentMethod: OrderPaymentMethod.CASH, paymentStatus: OrderPaymentStatus.PAID, paidAt: now, paidById: employeeId, servedAt: now, servedById: employeeId },
    });
    if (!claim.count) throw new ConflictException('Pickup order was already collected or is no longer ready');
    const completed = await this.prisma.order.findUniqueOrThrow({ where: { id }, include: this.orderDetails() });
    this.orderEvents.next({ type: 'updated', order: completed });
    return completed;
  }

  async cookStart(id: string) { return this.transition(id, OrderStatus.PENDING, OrderStatus.PREPARING); }
  async cookReady(id: string) { return this.transition(id, OrderStatus.PREPARING, OrderStatus.READY); }
  async acknowledgeReady(id: string, servedById: string) { return this.transition(id, OrderStatus.READY, OrderStatus.SERVED, servedById); }

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

  private async transition(id: string, from: OrderStatus, to: OrderStatus, servedById?: string) {
    const now = new Date();
    const changed = await this.prisma.order.updateMany({
      where: { id, status: from },
      data: {
        status: to,
        ...(to === OrderStatus.PREPARING ? { preparingAt: now } : {}),
        ...(to === OrderStatus.READY ? { readyAt: now } : {}),
        ...(to === OrderStatus.SERVED ? { servedAt: now } : {}),
        ...(to === OrderStatus.SERVED && servedById ? { servedById } : {}),
      },
    });
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

  private async setStatus(order: { id: string; tableId: string | null; status: OrderStatus; preparingAt: Date | null; readyAt: Date | null; servedAt: Date | null }, status: OrderStatus, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          status,
          ...(status === OrderStatus.PREPARING && !order.preparingAt ? { preparingAt: now } : {}),
          ...(status === OrderStatus.READY && !order.readyAt ? { readyAt: now } : {}),
          ...(status === OrderStatus.SERVED && !order.servedAt ? { servedAt: now } : {}),
          ...(status === OrderStatus.SERVED ? { servedById: actorId } : {}),
        },
        include: this.orderDetails(),
      });
      if ((status === OrderStatus.COMPLETED || status === OrderStatus.CANCELLED) && order.tableId) {
        const activeOrders = await tx.order.count({ where: { tableId: order.tableId, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } } });
        if (activeOrders === 0) await tx.table.update({ where: { id: order.tableId }, data: { status: TableStatus.AVAILABLE } });
      }
      return updated;
    });
  }

  private orderDetails() {
    return { items: { include: { menuItem: true } }, table: true, roomStay: { include: { room: true } }, waiter: { select: { id: true, name: true } }, servedBy: { select: { id: true, name: true } }, paidBy: { select: { id: true, name: true } } };
  }
}
