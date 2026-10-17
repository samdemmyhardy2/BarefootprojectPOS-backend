import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { Role, TaskStatus } from 'prisma/generated/prisma/enums';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string, role: Role) {
    return this.prisma.task.findMany({
      where: role === Role.ADMIN ? undefined : { assignments: { some: { employeeId: userId } } },
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
      include: this.details(),
    });
  }

  assignees(role: Role, jobTitle?: string) {
    const chefOnly = role !== Role.ADMIN && jobTitle?.trim().toLowerCase() === 'chef';
    return this.prisma.user.findMany({
      where: { role: Role.EMPLOYEE, ...(chefOnly ? { jobTitle: { equals: 'Chef', mode: 'insensitive' as const } } : {}) },
      orderBy: { name: 'asc' }, select: { id: true, name: true, jobTitle: true, avatarUrl: true },
    });
  }

  async create(createdById: string, dto: CreateTaskDto) {
    const creator = await this.prisma.user.findUnique({ where: { id: createdById }, select: { role: true, jobTitle: true } });
    if (!creator) throw new NotFoundException('Task creator was not found');
    const assignees = await this.prisma.user.findMany({ where: { id: { in: [...new Set(dto.assignedToIds)] }, role: Role.EMPLOYEE }, select: { id: true, jobTitle: true } });
    if (assignees.length !== new Set(dto.assignedToIds).size) throw new NotFoundException('One or more employees to assign were not found');
    if (creator.role !== Role.ADMIN && creator.jobTitle.trim().toLowerCase() === 'chef') {
      if (assignees.some((employee) => employee.jobTitle.trim().toLowerCase() !== 'chef')) throw new ForbiddenException('Chefs can assign tasks only to kitchen staff');
    }
    return this.prisma.task.create({
      data: { title: dto.title.trim(), description: dto.description?.trim() || null, assignments: { create: [...new Set(dto.assignedToIds)].map((employeeId) => ({ employeeId })) }, createdById, dueAt: dto.dueAt ? new Date(dto.dueAt) : null },
      include: this.details(),
    });
  }

  async updateStatus(id: string, userId: string, role: Role, status: TaskStatus) {
    const task = await this.prisma.task.findUnique({ where: { id }, select: { id: true, assignments: { select: { employeeId: true } } } });
    if (!task) throw new NotFoundException('Task not found');
    if (role !== Role.ADMIN && !task.assignments.some((assignment) => assignment.employeeId === userId)) throw new ForbiddenException('You can only update tasks assigned to you');
    return this.prisma.task.update({ where: { id }, data: { status }, include: this.details() });
  }

  async remove(id: string) {
    try { return await this.prisma.task.delete({ where: { id } }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') throw new NotFoundException('Task not found');
      throw error;
    }
  }

  private details() {
    return {
      assignments: { include: { employee: { select: { id: true, name: true, jobTitle: true, avatarUrl: true } } }, orderBy: { assignedAt: 'asc' as const } },
      createdBy: { select: { id: true, name: true } },
    } as const;
  }
}
