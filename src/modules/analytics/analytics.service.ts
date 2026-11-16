import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderPaymentMethod, OrderPaymentStatus, OrderStatus, RoomStatus } from 'prisma/generated/prisma/enums';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { OverviewQueryDto } from './dto/overview-query.dto';

type DayBucket = { date: string; revenue: number; orderCount: number; occupiedRoomNights: number };

function dateOnlyUtc(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: string, count: number) {
  const value = dateOnlyUtc(date);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function zonedDayStart(date: string, timeZone: string): Date {
  const target = dateOnlyUtc(date).getTime();
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(({ type, value }) => [type, value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const next = target - (represented - guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

function dateInZone(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const date = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${date.year}-${date.month}-${date.day}`;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(query: OverviewQueryDto) {
    const startDay = query.startDate;
    const endDay = query.endDate;
    const dayCount = (dateOnlyUtc(endDay).getTime() - dateOnlyUtc(startDay).getTime()) / 86_400_000 + 1;
    if (!Number.isInteger(dayCount) || dayCount < 1) throw new BadRequestException('End date must be on or after start date');
    if (dayCount > 366) throw new BadRequestException('Date range cannot exceed 366 days');

    let start: Date;
    let end: Date;
    try {
      start = zonedDayStart(startDay, query.timeZone);
      end = zonedDayStart(addDays(endDay, 1), query.timeZone);
    } catch {
      throw new BadRequestException('timeZone must be a valid IANA time zone');
    }

    const [orders, rooms, stays] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          OR: [
            { paymentStatus: OrderPaymentStatus.PAID, paidAt: { gte: start, lt: end } },
            { paymentStatus: OrderPaymentStatus.ROOM_FOLIO, roomCharge: { is: { occurredAt: { gte: start, lt: end } } } },
            // Older completed cash orders predate explicit payment timestamps.
            { paymentStatus: OrderPaymentStatus.UNPAID, paymentMethod: OrderPaymentMethod.CASH, status: OrderStatus.COMPLETED, updatedAt: { gte: start, lt: end } },
          ],
        },
        include: {
          roomCharge: true,
          items: { include: { menuItem: { include: { category: true } } } },
        },
      }),
      this.prisma.room.findMany({ where: { status: { not: RoomStatus.ARCHIVED } }, select: { id: true, status: true } }),
      this.prisma.roomStay.findMany({
        where: { checkedInAt: { lt: end }, OR: [{ checkedOutAt: null }, { checkedOutAt: { gt: start } }] },
        select: { roomId: true, checkedInAt: true, checkedOutAt: true },
      }),
    ]);

    const buckets = new Map<string, DayBucket>();
    for (let index = 0; index < dayCount; index += 1) {
      const date = addDays(startDay, index);
      buckets.set(date, { date, revenue: 0, orderCount: 0, occupiedRoomNights: 0 });
    }
    const categoryTotals = new Map<string, { id: string; name: string; quantity: number; revenue: number }>();
    const dishTotals = new Map<string, { id: string; name: string; categoryName: string; quantity: number; revenue: number }>();
    let totalRevenue = 0;
    for (const order of orders) {
      const paidAt = order.paymentStatus === OrderPaymentStatus.PAID ? order.paidAt : order.paymentStatus === OrderPaymentStatus.ROOM_FOLIO ? order.roomCharge?.occurredAt : order.updatedAt;
      if (!paidAt) continue;
      const amount = Number(order.totalAmount);
      totalRevenue += amount;
      const bucket = buckets.get(dateInZone(paidAt, query.timeZone));
      if (bucket) { bucket.revenue += amount; bucket.orderCount += 1; }
      for (const line of order.items) {
        const quantity = line.quantity;
        const lineRevenue = Number(line.subtotal);
        const copy = line.itemSnapshot && typeof line.itemSnapshot === 'object' && !Array.isArray(line.itemSnapshot) ? line.itemSnapshot as { name?: string; categoryName?: string } : {};
        const categoryId = line.menuItem?.category?.id ?? copy.categoryName ?? 'menu';
        const categoryName = copy.categoryName || line.menuItem?.category?.name || 'Menu';
        const dishId = line.menuItem?.id ?? line.menuItemId ?? copy.name ?? line.id;
        const dishLabel = copy.name || line.menuItem?.name || 'Removed dish';
        const categoryTotal = categoryTotals.get(categoryId) ?? { id: categoryId, name: categoryName, quantity: 0, revenue: 0 };
        categoryTotal.quantity += quantity;
        categoryTotal.revenue += lineRevenue;
        categoryTotals.set(categoryId, categoryTotal);
        const dishTotal = dishTotals.get(dishId) ?? { id: dishId, name: dishLabel, categoryName, quantity: 0, revenue: 0 };
        dishTotal.quantity += quantity;
        dishTotal.revenue += lineRevenue;
        dishTotals.set(dishId, dishTotal);
      }
    }

    const dayIntervals = [...buckets.values()].map((bucket) => ({
      bucket,
      start: zonedDayStart(bucket.date, query.timeZone).getTime(),
      end: zonedDayStart(addDays(bucket.date, 1), query.timeZone).getTime(),
    }));
    for (const stay of stays) {
      for (const day of dayIntervals) {
        const overlapStart = Math.max(day.start, stay.checkedInAt.getTime());
        const overlapEnd = Math.min(day.end, stay.checkedOutAt?.getTime() ?? end.getTime());
        if (overlapEnd > overlapStart) day.bucket.occupiedRoomNights += (overlapEnd - overlapStart) / (day.end - day.start);
      }
    }
    const dailyRevenue = [...buckets.values()];
    const occupiedRoomNights = dailyRevenue.reduce((sum, day) => sum + day.occupiedRoomNights, 0);
    const occupiedRooms = rooms.filter((room) => room.status === RoomStatus.OCCUPIED).length;
    const availableRooms = rooms.filter((room) => room.status === RoomStatus.AVAILABLE).length;
    const maintenanceRooms = rooms.filter((room) => room.status === RoomStatus.MAINTENANCE).length;
    const rentableRooms = occupiedRooms + availableRooms;

    return {
      startDate: startDay,
      endDate: endDay,
      timeZone: query.timeZone,
      totalRevenue,
      paidOrderCount: orders.length,
      averageOrderValue: orders.length ? totalRevenue / orders.length : 0,
      dailyRevenue,
      topCategories: [...categoryTotals.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 8),
      topDishes: [...dishTotals.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 8),
      occupancy: {
        occupiedRooms,
        availableRooms,
        maintenanceRooms,
        totalRooms: rooms.length,
        currentOccupancyRate: rentableRooms ? occupiedRooms / rentableRooms : 0,
        occupiedRoomNights,
        periodOccupancyRate: rentableRooms && dayCount ? occupiedRoomNights / (rentableRooms * dayCount) : 0,
      },
    };
  }
}
