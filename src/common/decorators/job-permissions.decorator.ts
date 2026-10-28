import { SetMetadata } from '@nestjs/common';

export const JOB_PERMISSIONS_KEY = 'jobPermissions';
export type JobPermission = 'ORDER_CREATE' | 'ORDER_VIEW' | 'ORDER_SERVE' | 'KITCHEN' | 'BAR' | 'TABLES' | 'ROOM_VIEW' | 'ROOM_MANAGE' | 'ROOM_FOLIO' | 'TASK_ASSIGN' | 'REPORTS';
export const JobPermissions = (...permissions: JobPermission[]) => SetMetadata(JOB_PERMISSIONS_KEY, permissions);
