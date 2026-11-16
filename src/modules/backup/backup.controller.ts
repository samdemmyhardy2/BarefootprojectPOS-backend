import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { BackupService } from './backup.service';

@ApiTags('Backups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('backups')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Get('status')
  @ApiOperation({ summary: 'Read the Google Drive backup schedule and last result (admin only)' })
  @ApiResponse({ status: 200, description: 'Configuration state, next run time, and the last run.' })
  getStatus() { return this.backups.status(); }

  @Post('run')
  @ApiOperation({ summary: 'Rebuild the orders workbook and room-tab-orders.xlsx, then upload both to Google Drive (admin only)' })
  @ApiResponse({ status: 201, description: 'The uploaded Drive file.' })
  @ApiResponse({ status: 503, description: 'Backup is not configured, or Google Drive rejected the upload.' })
  run() { return this.backups.run('MANUAL'); }
}
