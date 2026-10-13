import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@ApiTags('Categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}
  @Get() @ApiOperation({ summary: 'List categories with their menu items' }) @ApiResponse({ status: 200, description: 'Categories returned.' })
  findAll() { return this.categories.findAll(); }
  @Get(':id') @ApiOperation({ summary: 'Get category by ID' }) @ApiResponse({ status: 200, description: 'Category returned.' }) @ApiNotFoundResponse({ description: 'Category not found.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) { return this.categories.findOne(id); }
  @Post() @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN) @ApiOperation({ summary: 'Create a category (admin)' }) @ApiResponse({ status: 201, description: 'Category created.' }) @ApiConflictResponse({ description: 'Category name already exists.' }) @ApiBadRequestResponse({ description: 'Invalid category.' })
  create(@Body() dto: CreateCategoryDto) { return this.categories.create(dto); }
  @Patch(':id') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN) @ApiOperation({ summary: 'Update a category (admin)' }) @ApiResponse({ status: 200, description: 'Category updated.' }) @ApiNotFoundResponse({ description: 'Category not found.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) { return this.categories.update(id, dto); }
  @Delete(':id') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN) @ApiOperation({ summary: 'Delete an empty category (admin)' }) @ApiResponse({ status: 200, description: 'Category deleted.' }) @ApiConflictResponse({ description: 'Category still has menu items.' }) @ApiNotFoundResponse({ description: 'Category not found.' })
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.categories.remove(id); }
}
