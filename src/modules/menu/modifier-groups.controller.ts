import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreateModifierGroupDto, ModifierGroupQueryDto, UpdateModifierGroupDto } from './dto/modifier-group.dto';
import { ModifierGroupsService } from './modifier-groups.service';

@ApiTags('Modifier groups')
@Controller('modifier-groups')
export class ModifierGroupsController {
  constructor(private readonly groups: ModifierGroupsService) {}

  @Get() @ApiOperation({ summary: 'List modifier groups with options' })
  findAll(@Query() query: ModifierGroupQueryDto) { return this.groups.findAll(query.category); }

  @Get(':id') @ApiOperation({ summary: 'Get modifier group' })
  findOne(@Param('id', ParseUUIDPipe) id: string) { return this.groups.findOne(id); }

  @Post() @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN) @ApiOperation({ summary: 'Create a modifier group (admin)' })
  create(@Body() dto: CreateModifierGroupDto) { return this.groups.create(dto); }

  @Patch(':id') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN) @ApiOperation({ summary: 'Update a modifier group (admin)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateModifierGroupDto) { return this.groups.update(id, dto); }

  @Delete(':id') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN) @ApiOperation({ summary: 'Delete an unused modifier group (admin)' })
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.groups.remove(id); }
}
