import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { pageResponse, paginationWindow } from '../../common/pagination';

@Injectable()
export class MenuItemsService {
  constructor(private readonly prisma: PrismaService) {}
  private readonly menuItemInclude = {
    category: true,
    modifierGroups: {
      orderBy: { position: 'asc' as const },
      include: {
        group: {
          include: {
            options: {
              where: { active: true },
              orderBy: { position: 'asc' as const },
              include: {
                opensGroup: {
                  include: {
                    options: { where: { active: true }, orderBy: { position: 'asc' as const } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  async findAll(categoryId?: string, keyword?: string, page?: number, requestedLimit?: number) {
    const where: Prisma.MenuItemWhereInput = {};
    if (categoryId) where.categoryId = categoryId;
    if (keyword?.trim()) where.OR = [{ name: { contains: keyword.trim(), mode: 'insensitive' } }, { description: { contains: keyword.trim(), mode: 'insensitive' } }];
    const orderBy = [{ position: 'asc' as const }, { name: 'asc' as const }];
    if (page === undefined) return this.prisma.menuItem.findMany({ where, orderBy, include: this.menuItemInclude });
    const window = paginationWindow(page, requestedLimit);
    const [total, rows] = await Promise.all([
      this.prisma.menuItem.count({ where }),
      this.prisma.menuItem.findMany({ where, orderBy, skip: window.skip, take: window.take, include: this.menuItemInclude }),
    ]);
    return pageResponse(window.page, window.limit, total, Promise.resolve(rows));
  }
  async findOne(id: string) {
    const item = await this.prisma.menuItem.findUnique({ where: { id }, include: this.menuItemInclude });
    if (!item) throw new NotFoundException('Menu item not found');
    return item;
  }
  async create(dto: CreateMenuItemDto) {
    await this.assertCategory(dto.categoryId);
    const { modifierGroupIds = [], ...data } = dto;
    await this.assertModifierGroups(modifierGroupIds);
    return this.prisma.menuItem.create({
      data: { ...data, modifierGroups: { create: modifierGroupIds.map((groupId) => ({ group: { connect: { id: groupId } } })) } },
      include: this.menuItemInclude,
    });
  }
  async update(id: string, dto: UpdateMenuItemDto) {
    await this.findOne(id);
    if (dto.categoryId) await this.assertCategory(dto.categoryId);
    const { modifierGroupIds, ...data } = dto;
    if (modifierGroupIds !== undefined) await this.assertModifierGroups(modifierGroupIds);
    return this.prisma.menuItem.update({
      where: { id },
      data: {
        ...data,
        ...(modifierGroupIds !== undefined ? { modifierGroups: { deleteMany: {}, create: modifierGroupIds.map((groupId) => ({ group: { connect: { id: groupId } } })) } } : {}),
      },
      include: this.menuItemInclude,
    });
  }
  async remove(id: string) {
    await this.findOne(id);
    if (await this.prisma.orderItem.count({ where: { menuItemId: id } })) throw new ConflictException('Menu item has order history and cannot be deleted');
    return this.prisma.menuItem.delete({ where: { id } });
  }
  private async assertCategory(id: string) { if (!(await this.prisma.category.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Category not found'); }

  private async assertModifierGroups(ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new BadRequestException('Modifier groups must be unique.');
    const count = await this.prisma.modifierGroup.count({ where: { id: { in: uniqueIds } } });
    if (count !== uniqueIds.length) throw new NotFoundException('One or more modifier groups were not found.');
  }

}
