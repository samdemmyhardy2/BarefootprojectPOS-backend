import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';

@Injectable()
export class MenuItemsService {
  constructor(private readonly prisma: PrismaService) {}
  findAll(categoryId?: string, keyword?: string) {
    const where: Prisma.MenuItemWhereInput = {};
    if (categoryId) where.categoryId = categoryId;
    if (keyword?.trim()) where.OR = [{ name: { contains: keyword.trim(), mode: 'insensitive' } }, { description: { contains: keyword.trim(), mode: 'insensitive' } }];
    return this.prisma.menuItem.findMany({ where, orderBy: { name: 'asc' }, include: { category: true } });
  }
  async findOne(id: string) {
    const item = await this.prisma.menuItem.findUnique({ where: { id }, include: { category: true } });
    if (!item) throw new NotFoundException('Menu item not found');
    return item;
  }
  async create(dto: CreateMenuItemDto) {
    this.assertFoodLabelLanguages(dto);
    await this.assertCategory(dto.categoryId);
    return this.prisma.menuItem.create({ data: dto, include: { category: true } });
  }
  async update(id: string, dto: UpdateMenuItemDto) {
    const current = await this.findOne(id);
    this.assertFoodLabelLanguages({ ...current, ...dto });
    if (dto.categoryId) await this.assertCategory(dto.categoryId);
    return this.prisma.menuItem.update({ where: { id }, data: dto, include: { category: true } });
  }
  async remove(id: string) {
    await this.findOne(id);
    if (await this.prisma.orderItem.count({ where: { menuItemId: id } })) throw new ConflictException('Menu item has order history and cannot be deleted');
    return this.prisma.menuItem.delete({ where: { id } });
  }
  private async assertCategory(id: string) { if (!(await this.prisma.category.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Category not found'); }

  private assertFoodLabelLanguages(item: {
    allergens?: unknown; allergensMy?: unknown; allergensTh?: unknown;
    dietaryInfo?: unknown; dietaryInfoMy?: unknown; dietaryInfoTh?: unknown;
    availableExtras?: unknown; availableExtrasMy?: unknown; availableExtrasTh?: unknown;
  }) {
    const groups = [
      { field: 'allergens', my: 'allergensMy', th: 'allergensTh' },
      { field: 'dietaryInfo', my: 'dietaryInfoMy', th: 'dietaryInfoTh' },
      { field: 'availableExtras', my: 'availableExtrasMy', th: 'availableExtrasTh' },
    ];
    for (const group of groups) {
      const labels = item[group.field];
      const burmese = item[group.my];
      const thai = item[group.th];
      if (!Array.isArray(labels) || !Array.isArray(burmese) || !Array.isArray(thai)) {
        throw new BadRequestException(`${group.field} must include English, Burmese, and Thai label lists.`);
      }
      if (labels.length === 0 || labels.length !== burmese.length || labels.length !== thai.length
        || [...labels, ...burmese, ...thai].some((label) => typeof label !== 'string' || !label.trim())) {
        throw new BadRequestException(`Each ${group.field} label needs a non-empty English, Burmese, and Thai value in the same order.`);
      }
    }
  }
}
