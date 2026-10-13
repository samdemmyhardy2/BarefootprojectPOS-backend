import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { UpdateTableStatusDto } from './dto/update-table-status.dto';

@Injectable()
export class TablesService {
  constructor(private readonly prisma: PrismaService) {}
  findAll() { return this.prisma.table.findMany({ orderBy: { tableNumber: 'asc' } }); }
  async findOne(id: string) { const table = await this.prisma.table.findUnique({ where: { id } }); if (!table) throw new NotFoundException('Table not found'); return table; }
  async create(dto: CreateTableDto) {
    try { return await this.prisma.table.create({ data: dto }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Table number already exists'); throw error; }
  }
  async update(id: string, dto: UpdateTableDto) {
    await this.findOne(id);
    try { return await this.prisma.table.update({ where: { id }, data: dto }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Table number already exists'); throw error; }
  }
  async updateStatus(id: string, dto: UpdateTableStatusDto) {
    await this.findOne(id);
    return this.prisma.table.update({ where: { id }, data: { status: dto.status } });
  }
  async remove(id: string) {
    await this.findOne(id);
    const orders = await this.prisma.order.count({ where: { tableId: id } });
    if (orders) throw new ConflictException('A table with order history cannot be deleted');
    return this.prisma.table.delete({ where: { id } });
  }
}
