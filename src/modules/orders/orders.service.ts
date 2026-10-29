import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from 'src/utils/prisma/prisma.service';
import { IdempotencyService } from 'src/utils/prisma/idempotency.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { TableStatus } from 'prisma/generated/prisma/enums';
import { ModifierMadeAt, OrderPaymentMethod, OrderPaymentStatus, OrderStatus, OrderType, PrepStation, PrepTicketStatus } from 'prisma/generated/prisma/enums';
import { OrderPageQueryDto } from './dto/order-page-query.dto';

@Injectable()
export class OrdersService {
  private readonly orderEvents = new Subject<{ type: 'created' | 'updated' | 'deleted'; order: object | string }>();
  constructor(private readonly prisma: PrismaService, private readonly idempotency: IdempotencyService) { }

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
    if (paymentMethod === OrderPaymentMethod.CARD) throw new BadRequestException('Card payments are recorded when settling a room tab');
    if (dto.tableId && creator.role !== 'ADMIN' && creator.jobTitle.trim().toLowerCase() !== 'waiter') {
      throw new BadRequestException('Your job role cannot place orders for restaurant tables');
    }
    const waiterTableCheckout = Boolean(dto.tableId) && jobTitle === 'waiter';
    if (dto.roomStayId && creator.role !== 'ADMIN' && !waiterTableCheckout && !['guestwelcomer', 'bungalowmanager'].includes(jobTitle)) {
      throw new BadRequestException('Your job role cannot place orders against guest room stays');
    }
    if (paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && !dto.roomStayId) throw new BadRequestException('Choose an active room stay to charge at checkout');
    const table = dto.tableId ? await this.prisma.table.findUnique({ where: { id: dto.tableId }, include: { assignedRoomStays: { select: { id: true } } } }) : null;
    if (dto.tableId && !table) throw new NotFoundException('Table not found');
    if (dto.tableId && dto.roomStayId && !table?.assignedRoomStays.some((stay) => stay.id === dto.roomStayId)) throw new ConflictException('Choose a guest room assigned to this table');
    const roomStay = dto.roomStayId ? await this.prisma.roomStay.findUnique({ where: { id: dto.roomStayId }, include: { room: true, charges: { where: { settledAt: null }, select: { amount: true } } } }) : null;
    if (dto.roomStayId && !roomStay) throw new NotFoundException('Room stay not found');
    if (roomStay?.checkedOutAt) throw new ConflictException('Cannot add an order to a checked-out room');
    if (roomStay?.cashOnly && paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT) throw new ConflictException('This guest stay is set to cash only');

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
      include: { modifierGroups: { orderBy: { position: 'asc' }, include: { group: { include: { options: { where: { active: true }, orderBy: { position: 'asc' } } } } } } },
    });

    if (menuItems.length !== menuItemIds.length) {
      throw new NotFoundException(
        'One or more menu items were not found',
      );
    }

    const followUpGroupIds = [...new Set(menuItems.flatMap((menuItem) => menuItem.modifierGroups.flatMap((link) => link.group.options.flatMap((option) => option.opensGroupId ? [option.opensGroupId] : []))))];
    const followUpGroups = followUpGroupIds.length
      ? await this.prisma.modifierGroup.findMany({ where: { id: { in: followUpGroupIds } }, include: { options: { where: { active: true }, orderBy: { position: 'asc' } } } })
      : [];

    let totalAmount = 0;

    const orderItemsData = dto.items.map((item) => {
      const menuItem = menuItems.find((candidate) => candidate.id === item.menuItemId);
      if (!menuItem) throw new NotFoundException(`Menu item ${item.menuItemId} not found`);
      const validAllergens = new Set(menuItem.allergens ?? []);
      if (item.selectedAllergens?.some((allergen) => !validAllergens.has(allergen))) {
        throw new BadRequestException('Selected allergens must match the allergens configured for the menu item');
      }

      const directGroups = menuItem.modifierGroups.map((link) => link.group);
      const linkedFollowUpIds = new Set(directGroups.flatMap((group) => group.options.flatMap((option) => option.opensGroupId ? [option.opensGroupId] : [])));
      const groups = [...directGroups, ...followUpGroups.filter((group) => linkedFollowUpIds.has(group.id))];
      const groupsById = new Map(groups.map((group) => [group.id, group]));
      const requested = item.modifierSelections ?? [];
      if (new Set(requested.map((selection) => selection.groupId)).size !== requested.length) {
        throw new BadRequestException('Each modifier group can be submitted only once per menu item.');
      }
      const optionMap = new Map<string, { id: string; name: string; priceAdjustment: number; groupId: string }>();
      for (const group of groups) for (const option of group.options) optionMap.set(option.id, { id: option.id, name: option.name, priceAdjustment: Number(option.priceAdjustment), groupId: group.id });
      const selectedIds = new Set(requested.flatMap((selection) => selection.optionIds));
      const openableGroups = new Set(directGroups.map((group) => group.id));
      let changed = true;
      while (changed) {
        changed = false;
        for (const optionId of selectedIds) {
          const option = optionMap.get(optionId);
          const sourceGroup = option ? groupsById.get(option.groupId) : undefined;
          if (!option || !sourceGroup || !openableGroups.has(sourceGroup.id)) continue;
          const targetId = sourceGroup.options.find((candidate) => candidate.id === optionId)?.opensGroupId;
          if (targetId && groupsById.has(targetId) && !openableGroups.has(targetId)) { openableGroups.add(targetId); changed = true; }
        }
      }
      let modifierPrice = 0;
      const modifierSnapshots: { groupId: string; groupName: string; station: PrepStation; options: { id: string; name: string; price: number }[] }[] = [];
      for (const selection of requested) {
        const group = groupsById.get(selection.groupId);
        if (!group || !openableGroups.has(group.id)) throw new BadRequestException('A selected modifier group is not available for this menu item.');
        const ids = selection.optionIds;
        if (new Set(ids).size !== ids.length && !group.allowDuplicates) throw new BadRequestException(`${group.name} does not allow the same option more than once.`);
        if (ids.length < group.minPicks || ids.length > group.maxPicks) throw new BadRequestException(`${group.name} requires ${group.minPicks}–${group.maxPicks} picks.`);
        if (group.required && ids.length < 1) throw new BadRequestException(`${group.name} requires a selection.`);
        const options = ids.map((id, index) => {
          const option = optionMap.get(id);
          if (!option || option.groupId !== group.id) throw new BadRequestException(`An option is not part of ${group.name}.`);
          const charged = index < group.includedPicks ? 0 : option.priceAdjustment + Number(group.extraPickPrice);
          modifierPrice += charged;
          return { id: option.id, name: option.name, price: charged };
        });
        modifierSnapshots.push({ groupId: group.id, groupName: group.name, station: group.madeAt === ModifierMadeAt.SAME_AS_DISH ? (item.prepStation ?? menuItem.prepStation) : group.madeAt, options });
      }
      for (const group of groups.filter((candidate) => openableGroups.has(candidate.id))) {
        if (group.required && !requested.some((selection) => selection.groupId === group.id)) throw new BadRequestException(`${group.name} requires a selection.`);
      }

      const unitPrice = Number(menuItem.price) + modifierPrice;
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
        selectedAllergens: item.selectedAllergens ?? [],
        modifierSelections: modifierSnapshots,
        specialNotes:
          item.specialNotes || null,
      };
    });

    if (roomStay?.chargeLimit !== null && roomStay?.chargeLimit !== undefined && paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT) {
      const currentFolio = roomStay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      if (currentFolio + totalAmount > Number(roomStay.chargeLimit)) throw new ConflictException('This guest stay charge limit would be exceeded');
    }

    const stationTicketItems = new Map<PrepStation, Prisma.InputJsonObject[]>();
    const addTicketLine = (station: PrepStation, line: Prisma.InputJsonObject) => stationTicketItems.set(station, [...(stationTicketItems.get(station) ?? []), line]);
    orderItemsData.forEach((line, index) => {
      const requestedLine = dto.items[index];
      const menuItem = menuItems.find((candidate) => candidate.id === requestedLine.menuItemId)!;
      const modifiers = line.modifierSelections as { groupId: string; groupName: string; station: PrepStation; options: { id: string; name: string; price: number }[] }[];
      const sameStationModifiers = modifiers.filter((selection) => selection.station === menuItem.prepStation);
      const itemStation = requestedLine.prepStation ?? menuItem.prepStation;
      // Staff serve this dish straight away. It stays on the order, ticket, and receipt, and never becomes a kitchen or bar ticket.
      if (itemStation === PrepStation.BAR) return;
      addTicketLine(itemStation, {
        menuItemName: menuItem.name, quantity: line.quantity, modifierSelections: sameStationModifiers,
        removeIngredients: line.removeIngredients, addExtras: line.addExtras, specialNotes: line.specialNotes, selectedAllergens: line.selectedAllergens,
      });
      const otherStations = [...new Set(modifiers.map((selection) => selection.station).filter((station) => station !== itemStation))];
      for (const station of otherStations) addTicketLine(station, {
        menuItemName: menuItem.name, quantity: line.quantity,
        modifierSelections: modifiers.filter((selection) => selection.station === station),
        specialNotes: line.specialNotes,
      });
    });

    let replay = false;
    try {
    const order = await this.prisma.$transaction(async (tx) => {
      const prior = await this.idempotency.read(tx, 'order.create', dto.clientRequestId);
      if (prior) { replay = true; return prior; }
      replay = false;
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
      const prepTickets = [...stationTicketItems.entries()].map(([station, items]) => ({ station, items }));
      const servedAtTable = prepTickets.length === 0;
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
          ...(servedAtTable ? { status: OrderStatus.SERVED, servedAt: new Date(), servedById: waiterId } : {}),
          items: {
            create: orderItemsData,
          },
          ...(prepTickets.length ? { prepTickets: { create: prepTickets } } : {}),
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
          prepTickets: true,
        },
      });
      if (paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT && dto.roomStayId) {
        const summary = dto.items.map((line) => `${line.quantity}× ${menuItems.find((item) => item.id === line.menuItemId)?.name ?? 'item'}`).join(', ');
        await tx.roomCharge.create({ data: { stayId: dto.roomStayId, orderId: created.id, kind: 'RESTAURANT_ORDER', description: `Restaurant order: ${summary}`, quantity: 1, unitPrice: totalAmount, amount: totalAmount } });
      }
      await this.idempotency.write(tx, 'order.create', dto.clientRequestId, waiterId, created);
      return created;
    });
    if (!replay) this.orderEvents.next({ type: 'created', order: order as object });
    return order;
    } catch (error) {
      const saved = await this.idempotency.recover(error, 'order.create', dto.clientRequestId);
      if (saved) return saved;
      throw error;
    }
  }

  activeRoomStays() {
    return this.prisma.roomStay.findMany({
      where: { checkedOutAt: null, room: { status: 'OCCUPIED' } },
      select: { id: true, primaryGuestName: true, guestNotes: true, expectedCheckoutAt: true, occupants: { select: { id: true, name: true } }, room: { select: { roomNumber: true } } },
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
      this.prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit, include: { ...this.orderDetails(), roomCharge: { select: { signedByName: true, signatureData: true } } } }),
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

  async prepQueue(station: PrepStation) {
    return this.prisma.order.findMany({
      where: { status: { in: [OrderStatus.PENDING, OrderStatus.PREPARING] }, prepTickets: { some: { station, status: { in: [PrepTicketStatus.PENDING, PrepTicketStatus.PREPARING] } } } },
      orderBy: { createdAt: 'asc' }, include: this.orderDetails(),
    });
  }

  async updatePrepTicket(ticketId: string, station: PrepStation, action: 'prepare' | 'ready') {
    const ticket = await this.prisma.orderPrepTicket.findUnique({ where: { id: ticketId } });
    if (!ticket || ticket.station !== station) throw new NotFoundException('Prep ticket not found');
    const expected = action === 'prepare' ? PrepTicketStatus.PENDING : PrepTicketStatus.PREPARING;
    if (ticket.status !== expected) throw new ConflictException('This prep ticket has already changed; refresh and retry');
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.orderPrepTicket.updateMany({
        where: { id: ticketId, station, status: expected },
        data: action === 'prepare' ? { status: PrepTicketStatus.PREPARING, preparingAt: now } : { status: PrepTicketStatus.READY, readyAt: now },
      });
      if (!changed.count) throw new ConflictException('This prep ticket has already changed; refresh and retry');
      const remaining = await tx.orderPrepTicket.count({ where: { orderId: ticket.orderId, status: { not: PrepTicketStatus.READY } } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: ticket.orderId }, select: { id: true, status: true, preparingAt: true } });
      const nextStatus = remaining === 0 ? OrderStatus.READY : OrderStatus.PREPARING;
      return tx.order.update({
        where: { id: ticket.orderId },
        data: {
          ...(order.status !== nextStatus && order.status !== OrderStatus.SERVED && order.status !== OrderStatus.COMPLETED ? { status: nextStatus } : {}),
          ...(nextStatus === OrderStatus.PREPARING && !order.preparingAt ? { preparingAt: now } : {}),
          ...(nextStatus === OrderStatus.READY && order.status !== OrderStatus.READY ? { readyAt: now } : {}),
        },
        include: this.orderDetails(),
      });
    });
    this.orderEvents.next({ type: 'updated', order: updated });
    return updated;
  }

  async redirectPrepTicket(ticketId: string, station: PrepStation) {
    const ticket = await this.prisma.orderPrepTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Prep ticket not found');
    if (ticket.station === station) throw new BadRequestException('This ticket is already assigned to that station');
    if (ticket.status !== PrepTicketStatus.PENDING) throw new ConflictException('Only tickets that have not started preparation can be redirected');
    const order = await this.prisma.$transaction(async (tx) => {
      const destination = await tx.orderPrepTicket.findUnique({ where: { orderId_station: { orderId: ticket.orderId, station } } });
      if (destination && destination.status !== PrepTicketStatus.PENDING) {
        throw new ConflictException('The destination station already has a ticket in progress');
      }
      const moved = await tx.orderPrepTicket.updateMany({
        where: { id: ticket.id, station: ticket.station, status: PrepTicketStatus.PENDING },
        data: destination
          ? { items: [...(destination.items as Prisma.InputJsonArray), ...(ticket.items as Prisma.InputJsonArray)] }
          : { station },
      });
      if (!moved.count) throw new ConflictException('This prep ticket has already changed; refresh and retry');
      if (destination) await tx.orderPrepTicket.delete({ where: { id: ticket.id } });
      return tx.order.findUniqueOrThrow({ where: { id: ticket.orderId }, include: this.orderDetails() });
    });
    this.orderEvents.next({ type: 'updated', order });
    return order;
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

  async pickupKitchenTicket(ticketId: string, servedById: string) {
    const ticket = await this.prisma.orderPrepTicket.findUnique({ where: { id: ticketId }, select: { id: true, orderId: true, station: true } });
    if (!ticket || ticket.station !== PrepStation.KITCHEN) throw new NotFoundException('Prep ticket not found');
    return this.collectFromKitchen(ticket.orderId, servedById);
  }

  async pickupKitchenOrder(orderId: string, servedById: string) {
    return this.collectFromKitchen(orderId, servedById);
  }

  private async collectFromKitchen(orderId: string, servedById: string) {
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, preparingAt: true, readyAt: true } });
      if (!order) throw new NotFoundException('Order not found');
      if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED) {
        throw new ConflictException('This order can no longer be picked up');
      }
      if (order.status === OrderStatus.SERVED) {
        return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: this.orderDetails() });
      }
      await tx.orderPrepTicket.updateMany({
        where: { orderId, station: PrepStation.KITCHEN, status: { in: [PrepTicketStatus.PENDING, PrepTicketStatus.PREPARING] } },
        data: { status: PrepTicketStatus.READY, preparingAt: now, readyAt: now },
      });
      const remaining = await tx.orderPrepTicket.count({ where: { orderId, status: { not: PrepTicketStatus.READY } } });
      if (remaining > 0) {
        if (order.status !== OrderStatus.PENDING) {
          return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: this.orderDetails() });
        }
        return tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.PREPARING, preparingAt: order.preparingAt ?? now },
          include: this.orderDetails(),
        });
      }
      return tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.SERVED,
          preparingAt: order.preparingAt ?? now,
          readyAt: order.readyAt ?? now,
          servedAt: now,
          servedById,
        },
        include: this.orderDetails(),
      });
    });
    this.orderEvents.next({ type: 'updated', order: updated });
    return updated;
  }

  async cookStart(id: string) { return this.transition(id, OrderStatus.PENDING, OrderStatus.PREPARING); }
  async cookReady(id: string) { return this.transition(id, OrderStatus.PREPARING, OrderStatus.READY); }
  async acknowledgeReady(id: string, servedById: string) { return this.transition(id, OrderStatus.READY, OrderStatus.SERVED, servedById); }

  async revertReady(id: string) {
    const changed = await this.prisma.order.updateMany({
      where: { id, status: OrderStatus.SERVED },
      data: { status: OrderStatus.READY, servedAt: null, servedById: null },
    });
    if (!changed.count) {
      const order = await this.prisma.order.findUnique({ where: { id }, select: { id: true } });
      if (!order) throw new NotFoundException('Order not found');
      throw new ConflictException('Only a picked-up order can be reverted');
    }
    const updated = await this.prisma.order.findUniqueOrThrow({ where: { id }, include: this.orderDetails() });
    this.orderEvents.next({ type: 'updated', order: updated });
    return updated;
  }

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
    return { items: { include: { menuItem: true } }, prepTickets: true, table: true, roomStay: { include: { room: true, occupants: true } }, waiter: { select: { id: true, name: true } }, servedBy: { select: { id: true, name: true } }, paidBy: { select: { id: true, name: true } } };
  }
}
