import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { JobPermissions } from '../../common/decorators/job-permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AnalyticsService } from './analytics.service';
import { OverviewQueryDto } from './dto/overview-query.dto';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.EMPLOYEE)
@JobPermissions('REPORTS')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get paid sales, best-selling dishes and categories, and room occupancy for a date range' })
  @ApiOkResponse({ description: 'Date-range business overview with daily revenue series and occupancy summary.' })
  @ApiForbiddenResponse({ description: 'Only administrators, chief accountants, and bungalow managers can view reports.' })
  overview(@Query() query: OverviewQueryDto) { return this.analytics.overview(query); }
}
