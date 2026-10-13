import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() { return this.prisma.category.findMany({ orderBy: { name: 'asc' }, include: { items: true } }); }
  async findOne(id: string) {
    const category = await this.prisma.category.findUnique({ where: { id }, include: { items: true } });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }
  async create(dto: CreateCategoryDto) {
    try { return await this.prisma.category.create({ data: dto }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Category name already exists'); throw error; }
  }
  async update(id: string, dto: UpdateCategoryDto) {
    await this.findOne(id);
    try { return await this.prisma.category.update({ where: { id }, data: dto }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Category name already exists'); throw error; }
  }
  async remove(id: string) {
    await this.findOne(id);
    const count = await this.prisma.menuItem.count({ where: { categoryId: id } });
    if (count) throw new ConflictException('Move or remove this category’s menu items before deleting it');
    return this.prisma.category.delete({ where: { id } });
  }
}
