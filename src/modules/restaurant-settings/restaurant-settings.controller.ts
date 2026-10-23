import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UpdateRestaurantSettingsDto } from './dto/update-restaurant-settings.dto';
import { RestaurantSettingsService } from './restaurant-settings.service';

@ApiTags('Restaurant settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.EMPLOYEE)
@Controller('restaurant-settings')
export class RestaurantSettingsController {
  constructor(private readonly settings: RestaurantSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get the restaurant name and logo' })
  @ApiResponse({ status: 200, description: 'Current restaurant branding.' })
  get() { return this.settings.get(); }

  @Patch()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update restaurant name and logo (admin)' })
  @ApiResponse({ status: 200, description: 'Restaurant branding updated.' })
  update(@Body() dto: UpdateRestaurantSettingsDto) { return this.settings.update(dto); }
}
