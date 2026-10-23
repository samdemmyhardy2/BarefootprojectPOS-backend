import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { UpdateRestaurantSettingsDto } from './dto/update-restaurant-settings.dto';

const settingsId = 'restaurant';

@Injectable()
export class RestaurantSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  get() {
    return this.prisma.restaurantSetting.upsert({
      where: { id: settingsId },
      create: { id: settingsId },
      update: {},
    });
  }

  update(dto: UpdateRestaurantSettingsDto) {
    return this.prisma.restaurantSetting.upsert({
      where: { id: settingsId },
      create: { id: settingsId, name: dto.name, logoUrl: dto.logoUrl ?? null },
      update: { name: dto.name, logoUrl: dto.logoUrl ?? null },
    });
  }
}
