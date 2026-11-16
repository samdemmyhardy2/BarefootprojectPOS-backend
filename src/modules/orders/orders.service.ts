import {
  Injectable,
  Logger,
  OnModuleInit,
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
import { CreateCommissionItemDto } from './dto/create-commission-item.dto';
import { uploadPath } from '../../common/upload-path';
import { moneyRound, totalWithVat } from '../../common/vat';

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Midnight at the start of the hotel's calendar day. Checkout times are often early morning, so the clock time alone is not the departure. */
function bangkokDayStart(now = new Date()) {
  const shifted = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - BANGKOK_OFFSET_MS);
}

/** Last instant of the checkout calendar day. The order desk hides a room once this timestamp is in the past. */
function checkoutDayEnd(value: Date) {
  const shifted = new Date(value.getTime() + BANGKOK_OFFSET_MS);
  const nextMidnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - BANGKOK_OFFSET_MS;
  return new Date(nextMidnight - 1);
}

/** Guests checked in right now. Future reservations stay off the list. A guest stays selectable through the end of their expected checkout day. */
export function inHouseToday(now = new Date()): Prisma.RoomStayWhereInput {
  return {
    cancelledAt: null,
    checkedOutAt: null,
    roomId: { not: null },
    checkedInAt: { lte: now },
    OR: [{ expectedCheckoutAt: null }, { expectedCheckoutAt: { gte: bangkokDayStart(now) } }],
  };
}

function snapshotRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function takeOneKitchenDish(items: unknown) {
  const lines = Array.isArray(items) ? items.map((item) => ({ ...snapshotRecord(item) })) : [];
  const index = lines.findIndex((line) => Number(line.quantity ?? 1) > 0);
  if (index < 0) return { lines, finished: true };
  const next = Math.max(0, Number(lines[index].quantity ?? 1) - 1);
  lines[index] = { ...lines[index], quantity: next };
  return { lines, finished: lines.every((line) => Number(line.quantity ?? 0) <= 0) };
}

function allowedPicks(group: { appearance?: string | null; selectionType: string; maxPicks: number; options: { active: boolean }[] }) {
  const choices = group.options.filter((option) => option.active).length;
  if (group.appearance === 'CHECKBOX') return Math.max(group.maxPicks > 1 ? group.maxPicks : choices, 1);
  if (group.appearance === 'RADIO' || group.appearance === 'SLIDER' || group.selectionType === 'SINGLE') return 1;
  return Math.max(group.maxPicks, 1);
}

function decimalAmount(value: { toString(): string } | null | undefined) {
  if (value == null) return 0;
  const amount = Number(value.toString());
  return Number.isFinite(amount) ? amount : 0;
}

export function presentOrder(order: any) {
  if (!order || typeof order !== 'object' || !Array.isArray(order.items)) return order;
  const tableCopy = snapshotRecord(order.tableSnapshot);
  const copiedNumber = typeof tableCopy.tableNumber === 'string' ? tableCopy.tableNumber : '';
  const table = order.table
    ? { ...order.table, tableNumber: copiedNumber || order.table.tableNumber }
    : copiedNumber
      ? { id: order.tableId ?? '', tableNumber: copiedNumber, section: null }
      : order.table;
  return {
    ...order,
    table,
    items: order.items.map((item: any) => {
      const copy = snapshotRecord(item.itemSnapshot);
      const name = typeof copy.name === 'string' && copy.name ? copy.name : item.menuItem?.name ?? 'Removed dish';
      const categoryName = typeof copy.categoryName === 'string' && copy.categoryName ? copy.categoryName : item.menuItem?.category?.name ?? 'Menu';
      const imageUrl = uploadPath(typeof copy.imageUrl === 'string' ? copy.imageUrl : item.menuItem?.imageUrl ?? '');
      const menuItem = item.menuItem
        ? { ...item.menuItem, name, imageUrl, category: item.menuItem.category ? { ...item.menuItem.category, name: categoryName } : { id: '', name: categoryName } }
        : { id: item.menuItemId ?? item.id, name, description: null, price: item.unitPrice, imageUrl, prepStation: 'KITCHEN', active: false, categoryId: '', category: { id: '', name: categoryName } };
      return { ...item, kitchenFlag: copy.kitchenFlag === true, menuItem };
    }),
  };
}

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);
  private readonly orderEvents = new Subject<{ type: 'created' | 'updated' | 'deleted'; order: object | string }>();
  constructor(private readonly prisma: PrismaService, private readonly idempotency: IdempotencyService) { }

  onModuleInit() {
    void this.foldOpenTableOrders().catch((error: unknown) => this.logger.warn(error instanceof Error ? error.message : 'Could not fold open table orders'));
  }

  events() { return this.orderEvents.asObservable(); }

  async publishUpdates(ids: string[]) {
    if (!ids.length) return [];
    const orders = await this.prisma.order.findMany({ where: { id: { in: ids } }, include: this.orderDetails() });
    return orders.map((order) => {
      const shown = presentOrder(order);
      this.orderEvents.next({ type: 'updated', order: shown });
      return shown;
    });
  }

  async liveSnapshot() {
    const orders = await this.prisma.order.findMany({
      where: { status: { in: [OrderStatus.PENDING, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.SERVED] } },
      orderBy: { createdAt: 'asc' },
      include: this.orderDetails(),
    });
    return orders.map(presentOrder);
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
    const table = dto.tableId ? await this.prisma.table.findUnique({ where: { id: dto.tableId }, include: { assignedRoomStays: { include: { room: true, occupants: true } }, splits: true } }) : null;
    if (dto.tableId && !table) throw new NotFoundException('Table not found');
    const split = dto.tableSplitId ? table?.splits.find((entry) => entry.id === dto.tableSplitId) : null;
    if (dto.tableSplitId && !split) throw new BadRequestException('That side of the table was not found');
    if (table?.splits.length && !split) throw new BadRequestException('Choose which side of the table this order is for');
    const splitStay = split?.roomStayId ? await this.prisma.roomStay.findUnique({ where: { id: split.roomStayId }, include: { room: true, occupants: true, charges: { where: { settledAt: null, kind: { not: 'ROOM_FEE' } }, select: { amount: true } } } }) : null;
    if (split?.roomStayId && !splitStay) throw new NotFoundException('Room stay not found');
    if (splitStay?.checkedOutAt) throw new ConflictException('Cannot add an order to a checked-out room');
    if (dto.tableId && dto.roomStayId && !split && !table?.assignedRoomStays.some((stay) => stay.id === dto.roomStayId)) throw new ConflictException('Choose a guest room assigned to this table');
    const roomStay = dto.roomStayId ? await this.prisma.roomStay.findUnique({ where: { id: dto.roomStayId }, include: { room: true, occupants: true, charges: { where: { settledAt: null, kind: { not: 'ROOM_FEE' } }, select: { amount: true } } } }) : null;
    const seatedStay = split ? splitStay : (!dto.roomStayId && table?.assignedRoomStays.length === 1 ? table.assignedRoomStays[0] : null);
    const linkedStayId = dto.roomStayId ?? seatedStay?.id ?? null;
    const guestStay = roomStay ?? seatedStay;
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
      include: { category: { select: { name: true } }, modifierGroups: { orderBy: { position: 'asc' }, include: { group: { include: { options: { where: { active: true }, orderBy: { position: 'asc' } } } } } } },
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

    const orderItemsData = dto.items.map((item, index) => {
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
        const maxPicks = allowedPicks(group);
        if (ids.length < group.minPicks || ids.length > maxPicks) throw new BadRequestException(`${group.name} requires ${group.minPicks}–${maxPicks} picks.`);
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

      if (menuItem.manualPrice && (item.unitPrice == null || Number.isNaN(Number(item.unitPrice)))) {
        throw new BadRequestException(`${menuItem.name} needs an amount.`);
      }
      const dishPrice = menuItem.manualPrice ? Number(item.unitPrice) : Number(menuItem.price);
      const unitPrice = dishPrice + modifierPrice;
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
        itemSnapshot: { name: menuItem.name, categoryName: menuItem.category?.name ?? 'Menu', imageUrl: menuItem.imageUrl ? uploadPath(menuItem.imageUrl) : null, lineIndex: index, kitchenFlag: Boolean(item.kitchenFlag) },
      };
    });

    const vatSetting = await this.prisma.restaurantSetting.findUnique({ where: { id: 'restaurant' }, select: { vatPercent: true } });
    const vatPercent = Number(vatSetting?.vatPercent ?? 0);
    const chargedAmount = totalWithVat(totalAmount, vatPercent);
    if (roomStay?.chargeLimit !== null && roomStay?.chargeLimit !== undefined && paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT) {
      const currentFolio = roomStay.charges.reduce((sum, charge) => sum + Number(charge.amount), 0);
      if (currentFolio + chargedAmount > Number(roomStay.chargeLimit)) throw new ConflictException('This guest stay charge limit would be exceeded');
    }

    const stationTicketItems = new Map<PrepStation, Prisma.InputJsonObject[]>();
    const addTicketLine = (station: PrepStation, line: Prisma.InputJsonObject) => stationTicketItems.set(station, [...(stationTicketItems.get(station) ?? []), line]);
    orderItemsData.forEach((line, index) => {
      const requestedLine = dto.items[index];
      const menuItem = menuItems.find((candidate) => candidate.id === requestedLine.menuItemId)!;
      const modifiers = line.modifierSelections as { groupId: string; groupName: string; station: PrepStation; options: { id: string; name: string; price: number }[] }[];
      const itemStation = requestedLine.prepStation ?? menuItem.prepStation;
      const sendsTicket = itemStation === PrepStation.KITCHEN || itemStation === PrepStation.BAR;
      const sameStationModifiers = modifiers.filter((selection) => selection.station === itemStation);
      const kitchenFlag = Boolean(requestedLine.kitchenFlag);
      if (sendsTicket) addTicketLine(itemStation, {
        menuItemName: menuItem.name, quantity: line.quantity, imageUrl: menuItem.imageUrl ? uploadPath(menuItem.imageUrl) : null, modifierSelections: sameStationModifiers,
        removeIngredients: line.removeIngredients, addExtras: line.addExtras, specialNotes: line.specialNotes, selectedAllergens: line.selectedAllergens,
        lineIndex: index, kitchenFlag,
      });
      const otherStations = [...new Set(modifiers.map((selection) => selection.station).filter((station) => station !== itemStation && (station === PrepStation.KITCHEN || station === PrepStation.BAR)))];
      for (const station of otherStations)       addTicketLine(station, {
        menuItemName: menuItem.name, quantity: line.quantity, imageUrl: menuItem.imageUrl ? uploadPath(menuItem.imageUrl) : null,
        modifierSelections: modifiers.filter((selection) => selection.station === station),
        specialNotes: line.specialNotes,
        lineIndex: index, kitchenFlag,
      });
    });

    let replay = false;
    let appended = false;
    const removedIds: string[] = [];
    try {
    const order = await this.prisma.$transaction(async (tx) => {
      const prior = await this.idempotency.read(tx, 'order.create', dto.clientRequestId);
      if (prior) { replay = true; return prior; }
      replay = false;
      if (linkedStayId) {
        // A conditional no-op update locks the stay row so a concurrent
        // checkout cannot close it between validation and order creation.
        const activeStay = await tx.roomStay.updateMany({ where: { id: linkedStayId, checkedOutAt: null }, data: { checkedOutAt: null } });
        if (!activeStay.count) throw new ConflictException('Room stay is closed; select a current guest');
      }
      // OCCUPIED tables may receive additional tickets. Claim the table only
      // when it was free/reserved, while still handling concurrent first orders.
      if (table && table.status !== TableStatus.OCCUPIED) {
        const tableClaim = await tx.table.updateMany({ where: { id: table.id, status: table.status }, data: { status: TableStatus.OCCUPIED } });
        if (!tableClaim.count) throw new ConflictException('Table status changed; refresh and retry');
      }
      const prepTickets: { station: PrepStation; items: Prisma.InputJsonValue }[] = [];
      for (const [station, items] of stationTicketItems) {
        if (station === PrepStation.NONE) continue;
        if (station === PrepStation.KITCHEN) prepTickets.push(...items.map((item) => ({ station, items: [item] })));
        else prepTickets.push({ station, items });
      }
      const summary = dto.items.map((line) => `${line.quantity}× ${menuItems.find((item) => item.id === line.menuItemId)?.name ?? 'item'}`).join(', ');
      const joined = table && orderType === OrderType.DINE_IN
        ? await this.appendToOpenTableOrder(tx, { tableId: table.id, tableSplitId: split?.id ?? null, paymentMethod, linkedStayId, totalAmount, chargedAmount, summary, items: orderItemsData, prepTickets })
        : null;
      if (joined) {
        appended = true;
        removedIds.push(...joined.removedIds);
        await this.idempotency.write(tx, 'order.create', dto.clientRequestId, waiterId, joined.order);
        return joined.order;
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(914201)`;
      const latest = await tx.order.aggregate({ _max: { number: true } });
      const number = (latest._max.number ?? 0) + 1;
      const servedAtTable = prepTickets.length === 0;
      const created = await tx.order.create({
        data: {
          number,
          type: orderType,
          customerName: orderType === OrderType.PICKUP ? dto.customerName!.trim() : null,
          customerPhone: orderType === OrderType.PICKUP ? dto.customerPhone?.trim() || null : null,
          tableId: dto.tableId ?? null,
          tableSplitId: split?.id ?? null,
          tableSnapshot: table ? { tableNumber: `${table.tableNumber}${split?.label ?? ''}` } : undefined,
          roomStayId: linkedStayId,
          ...(guestStay ? { roomGuestsSnapshot: [{ roomNumber: guestStay.room?.roomNumber ?? 'Unassigned', guestName: guestStay.primaryGuestName, guestNames: [...new Set([guestStay.primaryGuestName, ...guestStay.occupants.map((person) => person.name)].filter(Boolean))] }] } : {}),
          paymentMethod,
          paymentStatus: paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT ? OrderPaymentStatus.ROOM_FOLIO : OrderPaymentStatus.UNPAID,
          waiterId,
          totalAmount,
          vatPercent,
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
        await tx.roomCharge.create({ data: { stayId: dto.roomStayId, orderId: created.id, kind: 'RESTAURANT_ORDER', description: `${orderType === OrderType.ROOM_SERVICE ? 'Room service' : 'Restaurant order'}: ${summary}`, quantity: 1, unitPrice: chargedAmount, amount: chargedAmount } });
      }
      await this.idempotency.write(tx, 'order.create', dto.clientRequestId, waiterId, created);
      return created;
    });
    const shown = presentOrder(order);
    if (!replay) {
      for (const id of removedIds) this.orderEvents.next({ type: 'deleted', order: { id } });
      this.orderEvents.next({ type: appended ? 'updated' : 'created', order: shown });
    }
    return shown;
    } catch (error) {
      const saved = await this.idempotency.recover(error, 'order.create', dto.clientRequestId);
      if (saved) return saved;
      throw error;
    }
  }

  /** Open unpaid rounds on each table become one order, so a sitting keeps a single order number. */
  private async foldOpenTableOrders() {
    const open = await this.prisma.order.findMany({
      where: { tableId: { not: null }, type: OrderType.DINE_IN, paymentStatus: OrderPaymentStatus.UNPAID, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] }, roomCharge: { is: null } },
      select: { tableId: true, tableSplitId: true },
    });
    const groups = new Map<string, { tableId: string; tableSplitId: string | null; count: number }>();
    for (const order of open) {
      if (!order.tableId) continue;
      const key = `${order.tableId}:${order.tableSplitId ?? ''}`;
      const current = groups.get(key);
      groups.set(key, { tableId: order.tableId, tableSplitId: order.tableSplitId, count: (current?.count ?? 0) + 1 });
    }
    for (const group of groups.values()) {
      if (group.count < 2) continue;
      const folded = await this.prisma.$transaction((tx) => this.mergeOpenTableOrders(tx, group.tableId, group.tableSplitId));
      for (const id of folded.removedIds) this.orderEvents.next({ type: 'deleted', order: { id } });
      if (folded.removedIds.length && folded.keeperId) {
        const keeper = await this.prisma.order.findUnique({ where: { id: folded.keeperId }, include: this.orderDetails() });
        if (keeper) this.orderEvents.next({ type: 'updated', order: presentOrder(keeper) });
      }
    }
  }

  private lineIndexOf(snapshot: unknown) {
    const value = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? (snapshot as { lineIndex?: unknown }).lineIndex : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  /** Fold every open unpaid order on this table side into the oldest one. Room-folio orders stay separate. */
  private async mergeOpenTableOrders(tx: Prisma.TransactionClient, tableId: string, tableSplitId: string | null) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(914203, hashtext(${tableId}))`;
    const orders = await tx.order.findMany({
      where: { tableId, tableSplitId, type: OrderType.DINE_IN, paymentStatus: OrderPaymentStatus.UNPAID, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] }, roomCharge: { is: null } },
      orderBy: { createdAt: 'asc' },
      include: { items: true, prepTickets: true },
    });
    if (orders.length < 2) return { keeperId: orders[0]?.id ?? null, removedIds: [] as string[] };
    const keeper = orders[0];
    const rest = orders.slice(1);
    const stays = [...new Set(orders.map((order) => order.roomStayId).filter((id): id is string => Boolean(id)))];
    let next = 0;
    const movedIndex = new Map<string, number>();
    for (const order of orders) {
      const items = [...order.items].sort((left, right) => this.lineIndexOf(left.itemSnapshot) - this.lineIndexOf(right.itemSnapshot));
      for (const item of items) {
        movedIndex.set(`${order.id}:${this.lineIndexOf(item.itemSnapshot)}`, next);
        const snapshot = { ...snapshotRecord(item.itemSnapshot), lineIndex: next };
        await tx.orderItem.update({ where: { id: item.id }, data: { ...(order.id === keeper.id ? {} : { orderId: keeper.id }), itemSnapshot: snapshot as Prisma.InputJsonValue } });
        next += 1;
      }
    }
    for (const order of orders) {
      for (const ticket of order.prepTickets) {
        const lines = Array.isArray(ticket.items) ? ticket.items.map((line) => {
          const record = snapshotRecord(line);
          const updated = movedIndex.get(`${order.id}:${this.lineIndexOf(record)}`);
          return updated == null ? record : { ...record, lineIndex: updated };
        }) : ticket.items;
        await tx.orderPrepTicket.update({ where: { id: ticket.id }, data: { ...(order.id === keeper.id ? {} : { orderId: keeper.id }), items: lines as Prisma.InputJsonValue } });
      }
    }
    const removed = rest.map((order) => order.id);
    await tx.printJob.updateMany({ where: { orderId: { in: removed } }, data: { orderId: keeper.id } });
    const bills = await tx.tableBill.findMany({ where: { tableId }, select: { id: true, lines: true } });
    const removedSet = new Set(removed);
    for (const bill of bills) {
      if (!Array.isArray(bill.lines)) continue;
      let changed = false;
      const lines = (bill.lines as { orderId?: string }[]).map((line) => {
        if (!line?.orderId || !removedSet.has(line.orderId)) return line;
        changed = true;
        return { ...line, orderId: keeper.id };
      });
      if (changed) await tx.tableBill.update({ where: { id: bill.id }, data: { lines: lines as Prisma.InputJsonValue } });
    }
    const unfinished = orders.some((order) => order.prepTickets.some((ticket) => ticket.status !== PrepTicketStatus.READY));
    const allServed = orders.every((order) => order.status === OrderStatus.SERVED);
    await tx.order.update({
      where: { id: keeper.id },
      data: {
        totalAmount: moneyRound(orders.reduce((sum, order) => sum + Number(order.totalAmount), 0)),
        status: unfinished ? OrderStatus.PENDING : allServed ? OrderStatus.SERVED : OrderStatus.PREPARING,
        ...(stays.length === 1 ? { roomStayId: stays[0] } : {}),
        ...(unfinished || !allServed ? { servedAt: null, servedById: null } : {}),
      },
    });
    await tx.order.deleteMany({ where: { id: { in: removed } } });
    return { keeperId: keeper.id, removedIds: removed };
  }

  private async appendToOpenTableOrder(tx: Prisma.TransactionClient, round: {
    tableId: string; tableSplitId: string | null; paymentMethod: OrderPaymentMethod; linkedStayId: string | null;
    totalAmount: number; chargedAmount: number; summary: string;
    items: { menuItemId: string; quantity: number; unitPrice: number; subtotal: number; removeIngredients: string | null; addExtras: string | null; selectedAllergens: string[]; modifierSelections: unknown; specialNotes: string | null; itemSnapshot: { lineIndex: number } }[];
    prepTickets: { station: PrepStation; items: Prisma.InputJsonValue }[];
  }) {
    const openWhere = { tableId: round.tableId, tableSplitId: round.tableSplitId, type: OrderType.DINE_IN, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } };
    const removedIds: string[] = [];
    const open = round.paymentMethod === OrderPaymentMethod.ROOM_CHECKOUT
      ? await tx.order.findFirst({ where: { ...openWhere, paymentStatus: OrderPaymentStatus.ROOM_FOLIO, roomStayId: round.linkedStayId }, orderBy: { createdAt: 'asc' }, include: { items: { select: { itemSnapshot: true } }, roomCharge: true } })
      : await (async () => {
        const folded = await this.mergeOpenTableOrders(tx, round.tableId, round.tableSplitId);
        removedIds.push(...folded.removedIds);
        return tx.order.findFirst({ where: { ...openWhere, paymentStatus: OrderPaymentStatus.UNPAID, roomCharge: { is: null } }, orderBy: { createdAt: 'asc' }, include: { items: { select: { itemSnapshot: true } }, roomCharge: true } });
      })();
    if (!open) return null;
    const offset = open.items.reduce((max, item) => Math.max(max, this.lineIndexOf(item.itemSnapshot) + 1), 0);
    for (const line of round.items) {
      const snapshot = { ...line.itemSnapshot, lineIndex: line.itemSnapshot.lineIndex + offset };
      await tx.orderItem.create({ data: { orderId: open.id, menuItemId: line.menuItemId, quantity: line.quantity, unitPrice: line.unitPrice, subtotal: line.subtotal, removeIngredients: line.removeIngredients, addExtras: line.addExtras, selectedAllergens: line.selectedAllergens, modifierSelections: line.modifierSelections as Prisma.InputJsonValue, specialNotes: line.specialNotes, itemSnapshot: snapshot as Prisma.InputJsonValue } });
    }
    for (const ticket of round.prepTickets) {
      const lines = Array.isArray(ticket.items) ? ticket.items.map((line) => {
        const record = snapshotRecord(line);
        return { ...record, lineIndex: this.lineIndexOf(record) + offset };
      }) : ticket.items;
      await tx.orderPrepTicket.create({ data: { orderId: open.id, station: ticket.station, items: lines as Prisma.InputJsonValue } });
    }
    const addingWork = round.prepTickets.length > 0;
    const reopen = addingWork && open.status !== OrderStatus.PENDING && open.status !== OrderStatus.PREPARING;
    await tx.order.update({
      where: { id: open.id },
      data: {
        totalAmount: moneyRound(Number(open.totalAmount) + round.totalAmount),
        ...(round.linkedStayId && !open.roomStayId ? { roomStayId: round.linkedStayId } : {}),
        ...(reopen ? { status: OrderStatus.PENDING, servedAt: null, servedById: null } : {}),
      },
    });
    if (open.roomCharge && !open.roomCharge.settledAt) {
      const amount = moneyRound(Number(open.roomCharge.amount) + round.chargedAmount);
      await tx.roomCharge.update({ where: { id: open.roomCharge.id }, data: { amount, unitPrice: amount, description: `${open.roomCharge.description}; ${round.summary}` } });
    }
    const order = await tx.order.findUniqueOrThrow({
      where: { id: open.id },
      include: { items: { include: { menuItem: true } }, table: true, waiter: { select: { id: true, name: true, email: true } }, roomStay: { include: { room: true } }, prepTickets: true },
    });
    return { order, removedIds };
  }

  async activeRoomStays() {
    const stays = await this.prisma.roomStay.findMany({
      where: inHouseToday(),
      select: { id: true, primaryGuestName: true, cashOnly: true, guestNotes: true, expectedCheckoutAt: true, occupants: { select: { id: true, name: true } }, room: { select: { roomNumber: true } } },
      orderBy: { checkedInAt: 'desc' },
    });
    return stays.map((stay) => ({ ...stay, expectedCheckoutAt: stay.expectedCheckoutAt ? checkoutDayEnd(stay.expectedCheckoutAt) : stay.expectedCheckoutAt }));
  }

  async findAll() {
    const orders = await this.prisma.order.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      include: this.orderDetails(),
    });
    return orders.map(presentOrder);
  }

  async findPage(query: OrderPageQueryDto) {
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 10;
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from >= to) throw new BadRequestException('The start of the date range must be before its end');
    const filters: Prisma.OrderWhereInput[] = [];
    if (from || to) filters.push({ createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } });
    if (query.status) filters.push({ status: query.status });
    if (query.payment === 'UNPAID') filters.push({ paymentStatus: OrderPaymentStatus.UNPAID });
    if (query.payment === 'CASH' || query.payment === 'CARD' || query.payment === 'PROMPTPAY') filters.push({ paymentStatus: OrderPaymentStatus.PAID, paymentMethod: query.payment });
    if (query.payment === 'COUNTER') filters.push({ paymentStatus: OrderPaymentStatus.PAID, paymentMethod: { in: [OrderPaymentMethod.CASH, OrderPaymentMethod.CARD, OrderPaymentMethod.PROMPTPAY] } });
    if (query.payment === 'ROOM') filters.push({ OR: [{ paymentStatus: OrderPaymentStatus.ROOM_FOLIO }, { paymentMethod: OrderPaymentMethod.ROOM_CHECKOUT, paymentStatus: { not: OrderPaymentStatus.UNPAID } }] });
    if (query.place === 'TABLE') filters.push({ tableId: { not: null } });
    if (query.place === 'ROOM') filters.push({ tableId: null, OR: [{ roomStayId: { not: null } }, { type: OrderType.ROOM_SERVICE }] });
    if (query.place === 'WALKIN') filters.push({ tableId: null, roomStayId: null, type: { not: OrderType.ROOM_SERVICE } });
    const where: Prisma.OrderWhereInput = filters.length ? { AND: filters } : {};
    // Sales totals leave out cancelled orders, matching the Totals sheet of the Drive backup.
    const dated = (extra?: Prisma.OrderWhereInput): Prisma.OrderWhereInput => {
      const parts = [from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : undefined, { status: { not: OrderStatus.CANCELLED } }, extra].filter((part) => part != null);
      return { AND: parts };
    };
    const roomPayment: Prisma.OrderWhereInput = { OR: [{ paymentStatus: OrderPaymentStatus.ROOM_FOLIO }, { paymentMethod: OrderPaymentMethod.ROOM_CHECKOUT, paymentStatus: { not: OrderPaymentStatus.UNPAID } }] };
    const cashPayment: Prisma.OrderWhereInput = { paymentStatus: OrderPaymentStatus.PAID, paymentMethod: { in: [OrderPaymentMethod.CASH, OrderPaymentMethod.CARD, OrderPaymentMethod.PROMPTPAY] } };
    const commissionWhere: Prisma.RoomChargeWhereInput = {
      commissionAmount: { not: null },
      settledAt: { not: null, ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) },
    };
    const [items, total, summed, salesSum, salesCount, roomSum, roomCount, cashSum, cashCount, commissionSum, commissionCount, commissionRows] = await Promise.all([
      this.prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit, include: { ...this.orderDetails(), roomCharge: { select: { signedByName: true, signatureData: true, stay: { select: { primaryGuestName: true, occupants: { select: { name: true } }, room: { select: { roomNumber: true } } } } } } } }),
      this.prisma.order.count({ where }),
      this.prisma.order.aggregate({ where, _sum: { totalAmount: true } }),
      this.prisma.order.aggregate({ where: dated(), _sum: { totalAmount: true } }),
      this.prisma.order.count({ where: dated() }),
      this.prisma.order.aggregate({ where: dated(roomPayment), _sum: { totalAmount: true } }),
      this.prisma.order.count({ where: dated(roomPayment) }),
      this.prisma.order.aggregate({ where: dated(cashPayment), _sum: { totalAmount: true } }),
      this.prisma.order.count({ where: dated(cashPayment) }),
      this.prisma.roomCharge.aggregate({ where: commissionWhere, _sum: { commissionAmount: true } }),
      this.prisma.roomCharge.count({ where: commissionWhere }),
      query.payment === 'COMMISSION'
        ? this.prisma.roomCharge.findMany({
          where: commissionWhere,
          orderBy: { settledAt: 'desc' },
          skip: offset,
          take: limit,
          include: { stay: { select: { primaryGuestName: true, room: { select: { roomNumber: true } } } } },
        })
        : Promise.resolve([]),
    ]);
    const commissionItems = commissionRows.map((charge) => ({
      id: charge.id,
      name: charge.description,
      roomNumber: charge.stay.room?.roomNumber ?? null,
      guestName: charge.stay.primaryGuestName,
      quantity: charge.quantity,
      chargedAmount: Number(charge.amount),
      commissionAmount: Number(charge.commissionAmount ?? 0),
      paidAt: charge.settledAt,
    }));
    const pageItems = query.payment === 'COMMISSION' ? commissionItems : await this.withGuestHistory(items);
    const pageTotal = query.payment === 'COMMISSION' ? commissionCount : total;
    return {
      items: pageItems,
      total: pageTotal,
      totalAmount: decimalAmount(summed._sum.totalAmount),
      summary: {
        totalAmount: decimalAmount(salesSum._sum.totalAmount),
        totalCount: salesCount,
        roomAmount: decimalAmount(roomSum._sum.totalAmount),
        roomCount,
        cashAmount: decimalAmount(cashSum._sum.totalAmount),
        cashCount,
        commissionAmount: decimalAmount(commissionSum._sum.commissionAmount),
        commissionCount,
      },
      offset,
      limit,
      hasMore: offset + pageItems.length < pageTotal,
    };
  }

  async commissionItems() {
    const items = await this.prisma.commissionItem.findMany({ orderBy: { name: 'asc' } });
    return items.map((item) => ({ id: item.id, name: item.name, price: Number(item.price), commission: Number(item.commission) }));
  }

  async createCommissionItem(dto: CreateCommissionItemDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('A name is required');
    if (dto.commission > dto.price) throw new BadRequestException('The commission cannot be more than the amount the guest pays');
    const created = await this.prisma.commissionItem.create({
      data: { name, price: new Prisma.Decimal(dto.price), commission: new Prisma.Decimal(dto.commission) },
    });
    return { id: created.id, name: created.name, price: Number(created.price), commission: Number(created.commission) };
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

    return presentOrder(order);
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

    const updatedOrder = presentOrder(await this.setStatus(order, dto.status, actorId));
    this.orderEvents.next({ type: 'updated', order: updatedOrder });
    return updatedOrder;
  }

  async cookQueue() {
    const orders = await this.prisma.order.findMany({ where: { status: { in: [OrderStatus.PENDING, OrderStatus.PREPARING] } }, orderBy: { createdAt: 'asc' }, include: this.orderDetails() });
    return orders.map(presentOrder);
  }

  async prepQueue(station: PrepStation) {
    const orders = await this.prisma.order.findMany({
      where: { status: { in: [OrderStatus.PENDING, OrderStatus.PREPARING] }, prepTickets: { some: { station, status: { in: [PrepTicketStatus.PENDING, PrepTicketStatus.PREPARING] } } } },
      orderBy: { createdAt: 'asc' }, include: this.orderDetails(),
    });
    return orders.map(presentOrder);
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
    const shown = presentOrder(updated);
    this.orderEvents.next({ type: 'updated', order: shown });
    return shown;
  }

  async redirectPrepTicket(ticketId: string, station: PrepStation) {
    const ticket = await this.prisma.orderPrepTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Prep ticket not found');
    if (ticket.station === station) throw new BadRequestException('This ticket is already assigned to that station');
    if (ticket.status !== PrepTicketStatus.PENDING) throw new ConflictException('Only tickets that have not started preparation can be redirected');
    const order = await this.prisma.$transaction(async (tx) => {
      const destination = await tx.orderPrepTicket.findFirst({ where: { orderId: ticket.orderId, station, id: { not: ticket.id } } });
      if (destination && destination.status !== PrepTicketStatus.PENDING) {
        throw new ConflictException('The destination station already has a ticket in progress');
      }
      const moved = await tx.orderPrepTicket.updateMany({
        where: { id: ticket.id, station: ticket.station, status: PrepTicketStatus.PENDING },
        data: destination ? {} : { station },
      });
      if (!moved.count) throw new ConflictException('This prep ticket has already changed; refresh and retry');
      if (destination) {
        await tx.orderPrepTicket.update({ where: { id: destination.id }, data: { items: [...(destination.items as Prisma.InputJsonArray), ...(ticket.items as Prisma.InputJsonArray)] } });
        await tx.orderPrepTicket.delete({ where: { id: ticket.id } });
      }
      return tx.order.findUniqueOrThrow({ where: { id: ticket.orderId }, include: this.orderDetails() });
    });
    const shown = presentOrder(order);
    this.orderEvents.next({ type: 'updated', order: shown });
    return shown;
  }

  async readyOrders() {
    const orders = await this.prisma.order.findMany({ where: { status: OrderStatus.READY, type: { not: OrderType.PICKUP } }, orderBy: { readyAt: 'asc' }, include: this.orderDetails() });
    return orders.map(presentOrder);
  }

  async pickupOrders() {
    const orders = await this.prisma.order.findMany({
      where: { type: OrderType.PICKUP, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } },
      orderBy: { createdAt: 'asc' },
      include: this.orderDetails(),
    });
    return orders.map(presentOrder);
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
    const completed = presentOrder(await this.prisma.order.findUniqueOrThrow({ where: { id }, include: this.orderDetails() }));
    this.orderEvents.next({ type: 'updated', order: completed });
    return completed;
  }

  async pickupKitchenTicket(ticketId: string, servedById: string | null) {
    const ticket = await this.prisma.orderPrepTicket.findUnique({ where: { id: ticketId }, select: { id: true, orderId: true, station: true, status: true, items: true } });
    if (!ticket || ticket.station !== PrepStation.KITCHEN) throw new NotFoundException('Prep ticket not found');
    const now = new Date();
    const portion = takeOneKitchenDish(ticket.items);
    const updated = await this.prisma.$transaction(async (tx) => {
      if (ticket.status !== PrepTicketStatus.READY && !portion.finished) {
        await tx.orderPrepTicket.update({
          where: { id: ticket.id },
          data: { items: portion.lines as Prisma.InputJsonValue, ...(ticket.status === PrepTicketStatus.PENDING ? { status: PrepTicketStatus.PREPARING, preparingAt: now } : {}) },
        });
      } else if (ticket.status !== PrepTicketStatus.READY) {
        await tx.orderPrepTicket.update({ where: { id: ticket.id }, data: { items: portion.lines as Prisma.InputJsonValue, status: PrepTicketStatus.READY, preparingAt: now, readyAt: now } });
      }
      const order = await tx.order.findUnique({ where: { id: ticket.orderId }, select: { id: true, status: true, preparingAt: true, readyAt: true } });
      if (!order) throw new NotFoundException('Order not found');
      if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED || order.status === OrderStatus.SERVED) {
        return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: this.orderDetails() });
      }
      const remaining = await tx.orderPrepTicket.count({ where: { orderId: order.id, status: { not: PrepTicketStatus.READY } } });
      if (remaining > 0) {
        return tx.order.update({
          where: { id: order.id },
          data: order.status === OrderStatus.PENDING ? { status: OrderStatus.PREPARING, preparingAt: order.preparingAt ?? now } : {},
          include: this.orderDetails(),
        });
      }
      return tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.SERVED, preparingAt: order.preparingAt ?? now, readyAt: order.readyAt ?? now, servedAt: now, servedById },
        include: this.orderDetails(),
      });
    });
    const shown = presentOrder(updated);
    this.orderEvents.next({ type: 'updated', order: shown });
    return shown;
  }

  async pickupKitchenOrder(orderId: string, servedById: string | null) {
    return this.collectFromKitchen(orderId, servedById);
  }

  private async collectFromKitchen(orderId: string, servedById: string | null) {
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, preparingAt: true, readyAt: true } });
      if (!order) throw new NotFoundException('Order not found');
      if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED) {
        await tx.orderPrepTicket.updateMany({
          where: { orderId, station: PrepStation.KITCHEN, status: { in: [PrepTicketStatus.PENDING, PrepTicketStatus.PREPARING] } },
          data: { status: PrepTicketStatus.READY, preparingAt: now, readyAt: now },
        });
        return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: this.orderDetails() });
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
    const shown = presentOrder(updated);
    this.orderEvents.next({ type: 'updated', order: shown });
    return shown;
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
    const shown = presentOrder(updated);
    this.orderEvents.next({ type: 'updated', order: shown });
    return shown;
  }

  async remove(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { roomCharge: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.roomCharge) throw new ConflictException('A room-checkout order is part of a guest folio and cannot be deleted');
    await this.prisma.$transaction(async (tx) => {
      await tx.order.delete({ where: { id } });
      if (order.tableId) {
        const activeOrders = await tx.order.count({ where: { tableId: order.tableId, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } } });
        if (activeOrders === 0) {
          await tx.table.update({ where: { id: order.tableId }, data: { status: TableStatus.AVAILABLE } });
          await tx.tableSplit.deleteMany({ where: { tableId: order.tableId } });
        }
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
        if (activeOrders === 0) {
          await this.prisma.table.update({ where: { id: updated.tableId }, data: { status: TableStatus.AVAILABLE } });
          await this.prisma.tableSplit.deleteMany({ where: { tableId: updated.tableId } });
        }
      }
    }
    const shown = presentOrder(updated);
    this.orderEvents.next({ type: 'updated', order: shown });
    return shown;
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
      const settled = status === OrderStatus.COMPLETED && updated.paymentStatus === OrderPaymentStatus.UNPAID
        ? await tx.order.update({
          where: { id: order.id },
          data: { paymentStatus: OrderPaymentStatus.PAID, paidAt: updated.paidAt ?? now, paidById: updated.paidById ?? actorId },
          include: this.orderDetails(),
        })
        : updated;
      if ((status === OrderStatus.COMPLETED || status === OrderStatus.CANCELLED) && order.tableId) {
        const activeOrders = await tx.order.count({ where: { tableId: order.tableId, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } } });
        if (activeOrders === 0) {
          await tx.table.update({ where: { id: order.tableId }, data: { status: TableStatus.AVAILABLE } });
          await tx.tableSplit.deleteMany({ where: { tableId: order.tableId } });
        }
      }
      return settled;
    });
  }

  async removeItem(orderId: string, itemId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, prepTickets: true, roomCharge: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED) throw new ConflictException('This order is already closed');
    if (order.paymentStatus === OrderPaymentStatus.PAID) throw new ConflictException('This dish is already paid');
    const item = order.items.find((entry) => entry.id === itemId);
    if (!item) throw new NotFoundException('Dish not found');
    if (order.roomCharge?.settledAt) throw new ConflictException('This dish is already on a settled room bill');
    const bills = order.tableId ? await this.prisma.tableBill.findMany({ where: { tableId: order.tableId } }) : [];
    const billLines = (value: unknown) => (Array.isArray(value) ? value.map((line) => snapshotRecord(line)) : []);
    const dropsLine = (record: Record<string, unknown>, emptying: boolean) => {
      if (record.orderItemId === itemId) return true;
      return emptying && record.orderId === orderId;
    };
    if (bills.some((bill) => bill.status === 'SETTLED' && billLines(bill.lines).some((line) => dropsLine(line, order.items.length === 1)))) {
      throw new ConflictException('This dish is already on a settled bill');
    }
    const snapshot = snapshotRecord(item.itemSnapshot);
    const lineIndex = typeof snapshot.lineIndex === 'number' ? snapshot.lineIndex : order.items.findIndex((entry) => entry.id === itemId);
    const remaining = order.items.filter((entry) => entry.id !== item.id);
    const total = Math.round(remaining.reduce((sum, entry) => sum + decimalAmount(entry.subtotal), 0) * 100) / 100;
    const lineLabel = (entry: { quantity: number; itemSnapshot: unknown }) => {
      const copy = snapshotRecord(entry.itemSnapshot);
      const name = typeof copy.name === 'string' && copy.name ? copy.name : 'item';
      return `${entry.quantity}× ${name}`;
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.delete({ where: { id: item.id } });
      for (const ticket of order.prepTickets) {
        const lines = Array.isArray(ticket.items) ? ticket.items.map((line) => snapshotRecord(line)) : [];
        const kept = lines.filter((line) => Number(line.lineIndex) !== lineIndex);
        if (kept.length === lines.length) continue;
        if (!kept.length) await tx.orderPrepTicket.delete({ where: { id: ticket.id } });
        else await tx.orderPrepTicket.update({ where: { id: ticket.id }, data: { items: kept as Prisma.InputJsonValue } });
      }
      for (const bill of bills.filter((entry) => entry.status === 'OPEN')) {
        const lines = billLines(bill.lines).filter((line) => !dropsLine(line, remaining.length === 0));
        if (lines.length === billLines(bill.lines).length) continue;
        if (!lines.length) await tx.tableBill.delete({ where: { id: bill.id } });
        else {
          const amount = Math.round(lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0) * 100) / 100;
          await tx.tableBill.update({ where: { id: bill.id }, data: { lines: lines as Prisma.InputJsonValue, amount } });
        }
      }
      if (!remaining.length) {
        await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED, totalAmount: 0 } });
        if (order.roomCharge && !order.roomCharge.settledAt) await tx.roomCharge.delete({ where: { id: order.roomCharge.id } });
        if (order.tableId) {
          const activeOrders = await tx.order.count({ where: { tableId: order.tableId, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } } });
          if (activeOrders === 0) {
          await tx.table.update({ where: { id: order.tableId }, data: { status: TableStatus.AVAILABLE } });
          await tx.tableSplit.deleteMany({ where: { tableId: order.tableId } });
        }
        }
        return;
      }
      await tx.order.update({ where: { id: order.id }, data: { totalAmount: total } });
      if (order.roomCharge && !order.roomCharge.settledAt) {
        const charged = totalWithVat(total, Number(order.vatPercent));
        await tx.roomCharge.update({
          where: { id: order.roomCharge.id },
          data: { amount: charged, unitPrice: charged, description: `Restaurant order: ${remaining.map(lineLabel).join(', ')}` },
        });
      }
    });
    const shown = presentOrder(await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: this.orderDetails() }));
    this.orderEvents.next({ type: 'updated', order: shown });
    return shown;
  }

  async voidItem(orderId: string, itemId: string, reason: string) {
    const note = reason.trim();
    if (!note) throw new BadRequestException('Say why this dish is removed');
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, prepTickets: true, roomCharge: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.CANCELLED) throw new ConflictException('This order is already closed');
    if (order.paymentStatus === OrderPaymentStatus.PAID) throw new ConflictException('This dish is already paid');
    if (order.status === OrderStatus.COMPLETED && order.paymentStatus !== OrderPaymentStatus.ROOM_FOLIO) throw new ConflictException('This order is already closed');
    const item = order.items.find((entry) => entry.id === itemId);
    if (!item) throw new NotFoundException('Dish not found');
    if (item.removedAt) throw new ConflictException('This dish is already removed');
    if (order.roomCharge?.settledAt) throw new ConflictException('This dish is already on a settled room bill');
    const bills = order.tableId ? await this.prisma.tableBill.findMany({ where: { tableId: order.tableId } }) : [];
    const billLines = (value: unknown) => (Array.isArray(value) ? value.map((line) => snapshotRecord(line)) : []);
    const active = order.items.filter((entry) => entry.id !== item.id && !entry.removedAt);
    const dropsLine = (record: Record<string, unknown>, emptying: boolean) => {
      if (record.orderItemId === itemId) return true;
      return emptying && record.orderId === orderId;
    };
    if (bills.some((bill) => bill.status === 'SETTLED' && billLines(bill.lines).some((line) => dropsLine(line, active.length === 0)))) {
      throw new ConflictException('This dish is already on a settled bill');
    }
    const snapshot = snapshotRecord(item.itemSnapshot);
    const lineIndex = typeof snapshot.lineIndex === 'number' ? snapshot.lineIndex : order.items.findIndex((entry) => entry.id === itemId);
    const total = Math.round(active.reduce((sum, entry) => sum + decimalAmount(entry.subtotal), 0) * 100) / 100;
    const lineLabel = (entry: { quantity: number; itemSnapshot: unknown }) => {
      const copy = snapshotRecord(entry.itemSnapshot);
      const name = typeof copy.name === 'string' && copy.name ? copy.name : 'item';
      return `${entry.quantity}× ${name}`;
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.update({ where: { id: item.id }, data: { removedAt: new Date(), removalReason: note } });
      for (const ticket of order.prepTickets) {
        const lines = Array.isArray(ticket.items) ? ticket.items.map((line) => snapshotRecord(line)) : [];
        const kept = lines.filter((line) => Number(line.lineIndex) !== lineIndex);
        if (kept.length === lines.length) continue;
        if (!kept.length) await tx.orderPrepTicket.delete({ where: { id: ticket.id } });
        else await tx.orderPrepTicket.update({ where: { id: ticket.id }, data: { items: kept as Prisma.InputJsonValue } });
      }
      for (const bill of bills.filter((entry) => entry.status === 'OPEN')) {
        const lines = billLines(bill.lines).filter((line) => !dropsLine(line, active.length === 0));
        if (lines.length === billLines(bill.lines).length) continue;
        if (!lines.length) await tx.tableBill.delete({ where: { id: bill.id } });
        else {
          const amount = Math.round(lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0) * 100) / 100;
          await tx.tableBill.update({ where: { id: bill.id }, data: { lines: lines as Prisma.InputJsonValue, amount } });
        }
      }
      await tx.order.update({ where: { id: order.id }, data: { totalAmount: total } });
      if (order.roomCharge && !order.roomCharge.settledAt) {
        const storedLines = Array.isArray(order.roomCharge.lines) ? order.roomCharge.lines.map((line) => snapshotRecord(line)) : null;
        const nextLines = storedLines?.filter((line) => line.orderItemId !== itemId);
        const useLines = Boolean(storedLines && nextLines && nextLines.length !== storedLines.length);
        const food = useLines && nextLines ? Math.round(nextLines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0) * 100) / 100 : total;
        const charged = totalWithVat(food, Number(order.vatPercent));
        const labels = active.map(lineLabel);
        const prefix = order.roomCharge.description.includes(':') ? order.roomCharge.description.slice(0, order.roomCharge.description.indexOf(':')) : 'Restaurant order';
        await tx.roomCharge.update({
          where: { id: order.roomCharge.id },
          data: {
            amount: charged,
            unitPrice: charged,
            description: labels.length ? `${prefix}: ${labels.join(', ')}` : `${prefix}: removed`,
            ...(useLines ? { lines: nextLines as Prisma.InputJsonValue } : {}),
          },
        });
      }
    });
    const shown = presentOrder(await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: this.orderDetails() }));
    this.orderEvents.next({ type: 'updated', order: shown });
    return shown;
  }

  async setKitchenFlag(orderId: string, itemId: string, flagged: boolean) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true, prepTickets: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED) throw new ConflictException('This order is already closed');
    const item = order.items.find((entry) => entry.id === itemId);
    if (!item) throw new NotFoundException('Dish not found');
    const snapshot = snapshotRecord(item.itemSnapshot);
    const lineIndex = typeof snapshot.lineIndex === 'number' ? snapshot.lineIndex : order.items.findIndex((entry) => entry.id === itemId);
    await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.update({ where: { id: item.id }, data: { itemSnapshot: { ...snapshot, lineIndex, kitchenFlag: flagged } } });
      for (const ticket of order.prepTickets) {
        const lines = Array.isArray(ticket.items) ? ticket.items.map((line) => {
          const record = snapshotRecord(line);
          return Number(record.lineIndex) === lineIndex ? { ...record, kitchenFlag: flagged } : record;
        }) : [];
        if (lines.length) await tx.orderPrepTicket.update({ where: { id: ticket.id }, data: { items: lines as Prisma.InputJsonValue } });
      }
    });
    const shown = presentOrder(await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: this.orderDetails() }));
    this.orderEvents.next({ type: 'updated', order: shown });
    return shown;
  }

  private orderDetails() {
    return { items: { include: { menuItem: { include: { category: true } } } }, prepTickets: true, table: true, roomStay: { include: { room: true, occupants: true } }, waiter: { select: { id: true, name: true } }, servedBy: { select: { id: true, name: true } }, paidBy: { select: { id: true, name: true } } };
  }

  private async withGuestHistory(orders: any[]) {
    const shown = orders.map((order) => {
      const presented = presentOrder(order);
      const guests = Array.isArray(presented.roomGuestsSnapshot) ? presented.roomGuestsSnapshot : [];
      if (guests.length || presented.roomStay?.room) return presented;
      const stay = presented.roomCharge?.stay;
      if (!stay) return presented;
      const guestNames = [...new Set([stay.primaryGuestName, ...(stay.occupants ?? []).map((person: { name: string }) => person.name)].filter(Boolean))];
      return { ...presented, roomGuestsSnapshot: [{ roomNumber: stay.room?.roomNumber ?? 'Unassigned', guestName: stay.primaryGuestName, guestNames }] };
    });
    const tableIds = [...new Set(shown.map((order) => order.tableId).filter((tableId): tableId is string => Boolean(tableId)))];
    if (!tableIds.length) return shown;
    const bills = await this.prisma.tableBill.findMany({ where: { tableId: { in: tableIds }, status: 'SETTLED' } });
    const stayIds = [...new Set(bills.map((bill) => bill.stayId).filter((stayId): stayId is string => Boolean(stayId)))];
    const stays = stayIds.length ? await this.prisma.roomStay.findMany({ where: { id: { in: stayIds } }, include: { room: true, occupants: true } }) : [];
    return shown.map((order) => ({
      ...order,
      splits: bills.filter((bill) => Array.isArray(bill.lines) && (bill.lines as { orderId?: string }[]).some((line) => line.orderId === order.id)).map((bill) => {
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
          signedByName: bill.signedByName,
          signatureData: bill.signatureData,
          paidAt: bill.paidAt,
          chargeId: bill.chargeId,
          lines: Array.isArray(bill.lines) ? bill.lines : [],
          createdAt: bill.createdAt,
        };
      }),
    }));
  }
}
