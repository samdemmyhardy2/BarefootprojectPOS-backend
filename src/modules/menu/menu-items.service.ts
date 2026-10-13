import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
    await this.assertCategory(dto.categoryId);
    return this.prisma.menuItem.create({ data: dto, include: { category: true } });
  }
  async update(id: string, dto: UpdateMenuItemDto) {
    await this.findOne(id);
    if (dto.categoryId) await this.assertCategory(dto.categoryId);
    return this.prisma.menuItem.update({ where: { id }, data: dto, include: { category: true } });
  }
  async remove(id: string) {
    await this.findOne(id);
    if (await this.prisma.orderItem.count({ where: { menuItemId: id } })) throw new ConflictException('Menu item has order history and cannot be deleted');
    return this.prisma.menuItem.delete({ where: { id } });
  }
  private async assertCategory(id: string) { if (!(await this.prisma.category.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Category not found'); }
}
