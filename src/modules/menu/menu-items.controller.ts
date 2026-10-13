import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiNotFoundResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Role } from 'prisma/generated/prisma/enums';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { MenuItemsService } from './menu-items.service';

class MenuItemQueryDto {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
}
@ApiTags('Menu items')
@Controller('menu-items')
export class MenuItemsController {
  constructor(private readonly items: MenuItemsService) {}
  @Get() @ApiOperation({ summary: 'List and search menu items' }) @ApiQuery({ name: 'categoryId', required: false }) @ApiQuery({ name: 'keyword', required: false }) @ApiResponse({ status: 200, description: 'Menu items returned.' })
  findAll(@Query() query: MenuItemQueryDto) { return this.items.findAll(query.categoryId, query.keyword); }
  @Get(':id') @ApiOperation({ summary: 'Get menu item by ID' }) @ApiResponse({ status: 200, description: 'Menu item returned.' }) @ApiNotFoundResponse({ description: 'Menu item not found.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) { return this.items.findOne(id); }
  @Post() @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN) @ApiOperation({ summary: 'Create a menu item (admin)' }) @ApiResponse({ status: 201, description: 'Menu item created.' }) @ApiBadRequestResponse({ description: 'Invalid menu item.' }) @ApiNotFoundResponse({ description: 'Category not found.' })
  create(@Body() dto: CreateMenuItemDto) { return this.items.create(dto); }
  @Patch(':id') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN) @ApiOperation({ summary: 'Update a menu item (admin)' }) @ApiResponse({ status: 200, description: 'Menu item updated.' }) @ApiNotFoundResponse({ description: 'Menu item or category not found.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMenuItemDto) { return this.items.update(id, dto); }
  @Delete(':id') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN) @ApiOperation({ summary: 'Delete a menu item (admin)' }) @ApiResponse({ status: 200, description: 'Menu item deleted.' }) @ApiNotFoundResponse({ description: 'Menu item not found.' })
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.items.remove(id); }
}
