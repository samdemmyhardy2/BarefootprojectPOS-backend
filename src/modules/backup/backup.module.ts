import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { OrderExportService } from './order-export.service';

@Module({ controllers: [BackupController], providers: [BackupService, OrderExportService] })
export class BackupModule {}
