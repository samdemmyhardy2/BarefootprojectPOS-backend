import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateModifierGroupDto, UpdateModifierGroupDto } from './dto/modifier-group.dto';

@Injectable()
export class ModifierGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(category?: string) {
    return this.prisma.modifierGroup.findMany({
      where: category && category !== 'All groups' ? { category } : undefined,
      include: { options: { orderBy: { position: 'asc' } }, menuItems: { include: { menuItem: { select: { id: true, name: true } } } } },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  }

  async findOne(id: string) {
    const group = await this.prisma.modifierGroup.findUnique({ where: { id }, include: { options: { orderBy: { position: 'asc' } }, menuItems: { include: { menuItem: { select: { id: true, name: true } } } } } });
    if (!group) throw new NotFoundException('Modifier group not found');
    return group;
  }

  async create(dto: CreateModifierGroupDto) {
    this.assertRules(dto);
    await this.assertOpenedGroups(dto.options);
    return this.prisma.modifierGroup.create({ data: this.createData(dto), include: { options: { orderBy: { position: 'asc' } }, menuItems: true } });
  }

  async update(id: string, dto: UpdateModifierGroupDto) {
    const current = await this.findOne(id);
    this.assertRules({ ...current, ...dto, options: dto.options ?? current.options });
    if (dto.options) await this.assertOpenedGroups(dto.options);
    const { options, ...data } = dto;
    return this.prisma.modifierGroup.update({
      where: { id },
      data: { ...data, ...(options ? { options: { deleteMany: {}, create: this.optionsData(options) } } : {}) },
      include: { options: { orderBy: { position: 'asc' } }, menuItems: true },
    });
  }

  async remove(id: string) {
    const group = await this.findOne(id);
    if (group.menuItems.length) throw new ConflictException('Remove this modifier group from menu items before deleting it.');
    await this.prisma.modifierGroup.delete({ where: { id } });
    return { id };
  }

  private assertRules(dto: {
    options?: { defaultSelected?: boolean }[];
    minPicks?: number;
    maxPicks?: number;
    includedPicks?: number;
    required?: boolean;
    selectionType?: 'SINGLE' | 'MULTIPLE';
  }) {
    if (dto.options && dto.options.length < 1) throw new BadRequestException('A modifier group needs at least one option.');
    const min = dto.minPicks ?? 0;
    const max = dto.maxPicks ?? 1;
    const included = dto.includedPicks ?? 0;
    if (min > max || included > max) throw new BadRequestException('Pick limits and included picks must fit within the maximum picks.');
    if (dto.required && min < 1) throw new BadRequestException('A required modifier group must require at least one pick.');
    if (dto.selectionType === 'SINGLE' && max > 1) throw new BadRequestException('A single-choice modifier group can allow only one pick.');
    if (dto.options) {
      const defaults = dto.options.filter((option) => option.defaultSelected).length;
      if (defaults > max) throw new BadRequestException('Default options cannot exceed the maximum picks.');
    }
  }

  private createData(dto: CreateModifierGroupDto): Prisma.ModifierGroupCreateInput {
    const { options, ...data } = dto;
    return { ...data, options: { create: this.optionsData(options) } };
  }

  private optionsData(options: CreateModifierGroupDto['options']): Prisma.ModifierOptionCreateWithoutGroupInput[] {
    return options.map((option, index) => ({ ...option, position: option.position ?? index }));
  }

  private async assertOpenedGroups(options: CreateModifierGroupDto['options']) {
    const ids = [...new Set(options.flatMap((option) => option.opensGroupId ? [option.opensGroupId] : []))];
    if (!ids.length) return;
    const count = await this.prisma.modifierGroup.count({ where: { id: { in: ids } } });
    if (count !== ids.length) throw new NotFoundException('One or more follow-up modifier groups were not found.');
  }
}
