import { Injectable } from '@nestjs/common';
import { OrderStatus, RoomChargeKind } from 'prisma/generated/prisma/enums';
import { moneyRound, restaurantChargeGrand } from '../../common/vat';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { UpdateRestaurantSettingsDto } from './dto/update-restaurant-settings.dto';

const settingsId = 'restaurant';

@Injectable()
export class RestaurantSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get() {
    const saved = await this.prisma.restaurantSetting.upsert({
      where: { id: settingsId },
      create: { id: settingsId },
      update: {},
    });
    return { ...saved, vatPercent: Number(saved.vatPercent) };
  }

  async update(dto: UpdateRestaurantSettingsDto) {
    const saved = await this.prisma.$transaction(async (tx) => {
      const row = await tx.restaurantSetting.upsert({
        where: { id: settingsId },
        create: { id: settingsId, name: dto.name, logoUrl: dto.logoUrl ?? null, ...(dto.vatPercent !== undefined ? { vatPercent: dto.vatPercent } : {}) },
        update: { name: dto.name, logoUrl: dto.logoUrl ?? null, ...(dto.vatPercent !== undefined ? { vatPercent: dto.vatPercent } : {}) },
      });
      if (dto.vatPercent !== undefined) {
        const charges = await tx.roomCharge.findMany({
          where: { kind: { not: RoomChargeKind.ROOM_FEE } },
          select: { id: true, amount: true, quantity: true, lines: true, billId: true, kind: true, order: { select: { totalAmount: true, vatPercent: true, status: true } } },
        });
        const previousBills = await tx.tableBill.findMany({ select: { id: true, vatPercent: true } });
        const billRate = new Map(previousBills.map((bill) => [bill.id, Number(bill.vatPercent)]));
        await tx.order.updateMany({
          where: { status: { not: OrderStatus.CANCELLED } },
          data: { vatPercent: dto.vatPercent },
        });
        await tx.tableBill.updateMany({ data: { vatPercent: dto.vatPercent } });
        for (const charge of charges) {
          if (charge.order?.status === OrderStatus.CANCELLED) continue;
          const lines = Array.isArray(charge.lines) ? charge.lines as { amount?: unknown }[] : [];
          const food = lines.length
            ? moneyRound(lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0))
            : charge.order ? Number(charge.order.totalAmount) : null;
          if (food === null) continue;
          const previous = Number(charge.order?.vatPercent ?? (charge.billId ? billRate.get(charge.billId) : 0) ?? 0);
          const grand = restaurantChargeGrand(Number(charge.amount), food, previous, dto.vatPercent);
          if (grand === null) continue;
          const quantity = Number(charge.quantity) || 1;
          await tx.roomCharge.update({ where: { id: charge.id }, data: { amount: grand, unitPrice: moneyRound(grand / quantity) } });
        }
      }
      return row;
    });
    return { ...saved, vatPercent: Number(saved.vatPercent) };
  }
}
