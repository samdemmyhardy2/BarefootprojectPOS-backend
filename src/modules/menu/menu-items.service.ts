import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { uploadPath } from '../../common/upload-path';

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
  async findAll(categoryId?: string, keyword?: string, page?: number) {
    const where: Prisma.MenuItemWhereInput = {};
    if (categoryId) where.categoryId = categoryId;
    if (keyword?.trim()) where.OR = [{ name: { contains: keyword.trim(), mode: 'insensitive' } }, { description: { contains: keyword.trim(), mode: 'insensitive' } }];
    const rows = await this.prisma.menuItem.findMany({ where, orderBy: [{ position: 'asc' }, { name: 'asc' }], include: this.menuItemInclude });
    if (page === undefined) return rows;
    return { data: rows, page: 1, limit: rows.length, total: rows.length, totalPages: 1 };
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
    const item = await this.findOne(id);
    await this.prisma.$transaction(async (tx) => {
      const lines = await tx.orderItem.findMany({ where: { menuItemId: id }, select: { id: true, itemSnapshot: true } });
      for (const line of lines) {
        const current = line.itemSnapshot && typeof line.itemSnapshot === 'object' && !Array.isArray(line.itemSnapshot) ? line.itemSnapshot as { name?: string; categoryName?: string; imageUrl?: string | null } : {};
        await tx.orderItem.update({
          where: { id: line.id },
          data: {
            menuItemId: null,
            itemSnapshot: {
              name: current.name || item.name,
              categoryName: current.categoryName || item.category?.name || 'Menu',
              imageUrl: uploadPath(current.imageUrl || item.imageUrl || '') || null,
            },
          },
        });
      }
      await tx.menuItem.delete({ where: { id } });
    });
    return { id };
  }

  async importRows(rows: { category: string; name: string; description?: string; price: number; sendTo: 'KITCHEN' | 'BAR' | 'NONE' }[]) {
    let createdCategories = 0;
    let createdItems = 0;
    let updatedItems = 0;
    await this.prisma.$transaction(async (tx) => {
      const categories = await tx.category.findMany({ select: { id: true, name: true } });
      const byName = new Map(categories.map((category) => [category.name.trim().toLowerCase(), category]));
      for (const row of rows) {
        const categoryName = row.category.trim().replace(/\s+/g, ' ');
        const dishName = row.name.trim().replace(/\s+/g, ' ');
        if (!categoryName || !dishName) throw new BadRequestException('Each row needs a category and a name');
        let category = byName.get(categoryName.toLowerCase());
        if (!category) {
          const created = await tx.category.create({ data: { name: categoryName }, select: { id: true, name: true } });
          category = created;
          byName.set(categoryName.toLowerCase(), created);
          createdCategories += 1;
        }
        const existing = await tx.menuItem.findFirst({ where: { categoryId: category.id, name: { equals: dishName, mode: 'insensitive' } }, select: { id: true } });
        const data = { name: dishName, description: row.description?.trim() || null, price: row.price, prepStation: row.sendTo, categoryId: category.id };
        if (existing) {
          await tx.menuItem.update({ where: { id: existing.id }, data });
          updatedItems += 1;
        } else {
          await tx.menuItem.create({ data });
          createdItems += 1;
        }
      }
    });
    return { createdCategories, createdItems, updatedItems };
  }
  private async assertCategory(id: string) { if (!(await this.prisma.category.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Category not found'); }

  private async assertModifierGroups(ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new BadRequestException('Modifier groups must be unique.');
    const count = await this.prisma.modifierGroup.count({ where: { id: { in: uniqueIds } } });
    if (count !== uniqueIds.length) throw new NotFoundException('One or more modifier groups were not found.');
  }

}
