import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { JOB_PERMISSIONS_KEY, JobPermission } from '../decorators/job-permissions.decorator';
import { Role } from 'prisma/generated/prisma/enums';
import { PrismaService } from '../../utils/prisma/prisma.service';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector, private readonly prisma: PrismaService) { }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    const hasRole = requiredRoles.includes(user?.role);

    if (!hasRole) {
      throw new ForbiddenException('You do not have permission to access this resource');
    }

    const requiredJobPermissions = this.reflector.getAllAndOverride<JobPermission[]>(JOB_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
    if (!requiredJobPermissions?.length || user?.role === Role.ADMIN) return true;
    const currentUser = await this.prisma.user.findUnique({ where: { id: user?.id ?? user?.sub }, select: { role: true, jobTitle: true } });
    if (!currentUser) throw new ForbiddenException('Account is no longer available');
    if (currentUser.role === Role.ADMIN) return true;
    const jobTitle = currentUser.jobTitle.trim().toLowerCase().replace(/[^a-z]/g, '');
    const permissions: Record<JobPermission, string[]> = {
      ORDER_CREATE: ['waiter', 'guestwelcomer', 'bungalowmanager'], ORDER_VIEW: ['waiter', 'chef', 'bartender', 'barista', 'barman'], ORDER_SERVE: ['waiter'],
      KITCHEN: ['chef'], BAR: ['bartender', 'barista', 'barman'], TABLES: ['waiter'],
      ROOM_VIEW: ['bungalowmanager', 'guestwelcomer', 'chiefaccountant', 'cashier'],
      ROOM_MANAGE: ['bungalowmanager', 'guestwelcomer'],
      ROOM_FOLIO: ['bungalowmanager', 'guestwelcomer', 'chiefaccountant', 'cashier'],
      TASK_ASSIGN: ['chef', 'bungalowmanager'],
      REPORTS: ['chiefaccountant', 'bungalowmanager'],
    };
    if (!requiredJobPermissions.some((permission) => permissions[permission].includes(jobTitle))) {
      throw new ForbiddenException('Your job role does not have permission to perform this action');
    }

    return true;
  }
}
