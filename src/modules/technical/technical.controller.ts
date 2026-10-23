import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { TechnicalService } from './technical.service';

@ApiTags('Technical status')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('technical')
export class TechnicalController {
  constructor(private readonly technical: TechnicalService) {}

  @Get('status')
  @ApiOperation({ summary: 'Read server health and resource usage (admin only)' })
  @ApiResponse({ status: 200, description: 'Service health, CPU, memory, disk, and network usage.' })
  @ApiResponse({ status: 403, description: 'Admin access required.' })
  getStatus() { return this.technical.getStatus(); }
}
