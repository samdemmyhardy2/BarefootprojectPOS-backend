import { ConflictException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma } from 'prisma/generated/prisma/client';
import { Role } from 'prisma/generated/prisma/enums';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}
  async positions() {
    const existing = await this.prisma.user.findMany({ where: { role: Role.EMPLOYEE }, select: { jobTitle: true }, distinct: ['jobTitle'] });
    return [...new Set(['Waiter', 'Chef', 'Bartender', 'Barista', 'Chief Accountant', 'Bungalow Manager', 'Guest Welcomer', 'Gardener', 'Cashier', 'Housekeeping', ...existing.map((user) => user.jobTitle.trim()).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  }
  list() { return this.prisma.user.findMany({ where: { role: Role.EMPLOYEE }, select: this.employeeSelect(), orderBy: { name: 'asc' } }); }
  async get(id: string) { const user = await this.prisma.user.findFirst({ where: { id, role: Role.EMPLOYEE }, select: this.employeeSelect() }); if (!user) throw new NotFoundException('Employee not found'); return user; }
  async create(dto: CreateEmployeeDto) {
    try { return await this.prisma.user.create({ data: { name: dto.name, email: dto.email.toLowerCase(), password: await bcrypt.hash(dto.password, 12), jobTitle: dto.jobTitle, role: Role.EMPLOYEE }, select: this.employeeSelect() }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Email already belongs to an account'); throw error; }
  }
  async update(id: string, dto: UpdateEmployeeDto) {
    await this.get(id);
    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.jobTitle !== undefined) data.jobTitle = dto.jobTitle;
    if (dto.email !== undefined) data.email = dto.email.toLowerCase();
    if (dto.password !== undefined) {
      if (dto.password.length < 8) throw new BadRequestException('Password must be at least 8 characters');
      data.password = await bcrypt.hash(dto.password, 12);
    }
    try { return await this.prisma.user.update({ where: { id }, data, select: this.employeeSelect() }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Email already belongs to an account'); throw error; }
  }
  async remove(id: string) {
    await this.get(id);
    if (await this.prisma.order.count({ where: { waiterId: id } })) throw new ConflictException('Employee has order history and cannot be deleted; deactivate the account outside this operation');
    if (await this.prisma.taskAssignment.count({ where: { employeeId: id } })) throw new ConflictException('Reassign or delete this employee’s assigned tasks before deleting the account');
    await this.prisma.user.delete({ where: { id } });
    return { id, deleted: true };
  }
  async checkIn(employeeId: string) {
    const account = await this.prisma.user.findUnique({ where: { id: employeeId }, select: { id: true } });
    if (!account) throw new NotFoundException('Employee account not found');
    const openShift = await this.prisma.employeeShift.findFirst({ where: { employeeId, checkedOutAt: null } });
    if (openShift) throw new ConflictException('Employee is already checked in');
    try { return await this.prisma.employeeShift.create({ data: { employeeId } }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Employee is already checked in'); throw error; }
  }
  async checkOut(employeeId: string) {
    const shift = await this.prisma.employeeShift.findFirst({ where: { employeeId, checkedOutAt: null }, orderBy: { checkedInAt: 'desc' } });
    if (!shift) throw new ConflictException('Employee has no active shift');
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const result = await tx.employeeShift.updateMany({ where: { id: shift.id, checkedOutAt: null }, data: { checkedOutAt: now } });
      if (!result.count) throw new ConflictException('Shift was already checked out');
      await tx.shiftBreak.updateMany({ where: { employeeShiftId: shift.id, endedAt: null }, data: { endedAt: now } });
      return tx.employeeShift.findUnique({ where: { id: shift.id }, include: { breaks: true } });
    });
  }
  async startBreak(employeeId: string) {
    const shift = await this.prisma.employeeShift.findFirst({ where: { employeeId, checkedOutAt: null }, orderBy: { checkedInAt: 'desc' } });
    if (!shift) throw new ConflictException('Check in before starting a break');
    if (await this.prisma.shiftBreak.findFirst({ where: { employeeShiftId: shift.id, endedAt: null } })) throw new ConflictException('A short break is already in progress');
    try { return await this.prisma.shiftBreak.create({ data: { employeeShiftId: shift.id } }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('A short break is already in progress'); throw error; }
  }
  async endBreak(employeeId: string) {
    const shift = await this.prisma.employeeShift.findFirst({ where: { employeeId, checkedOutAt: null }, orderBy: { checkedInAt: 'desc' } });
    if (!shift) throw new ConflictException('There is no active shift');
    const activeBreak = await this.prisma.shiftBreak.findFirst({ where: { employeeShiftId: shift.id, endedAt: null } });
    if (!activeBreak) throw new ConflictException('There is no short break in progress');
    return this.prisma.shiftBreak.update({ where: { id: activeBreak.id }, data: { endedAt: new Date() } });
  }
  myShifts(employeeId: string) { return this.prisma.employeeShift.findMany({ where: { employeeId }, include: { breaks: { orderBy: { startedAt: 'asc' } } }, orderBy: { checkedInAt: 'desc' } }); }
  allShifts(employeeId?: string) { return this.prisma.employeeShift.findMany({ where: employeeId ? { employeeId } : undefined, include: { breaks: { orderBy: { startedAt: 'asc' } }, employee: { select: { id: true, name: true, email: true } } }, orderBy: { checkedInAt: 'desc' } }); }
  private employeeSelect() { return { id: true, name: true, email: true, role: true, jobTitle: true, avatarUrl: true, isOnline: true, createdAt: true, updatedAt: true } as const; }
}
