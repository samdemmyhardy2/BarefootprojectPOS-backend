import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { Roles } from '../../common/decorators/roles.decorator';
import { JobPermissions } from '../../common/decorators/job-permissions.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { TablesService } from './tables.service';
import { UpdateTableStatusDto } from './dto/update-table-status.dto';
import { CheckoutTableDto } from './dto/checkout-table.dto';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { UpdateTableLayoutDto } from './dto/update-table-layout.dto';
import { AssignTableRoomDto } from './dto/assign-table-room.dto';

@ApiTags('Tables') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN, Role.EMPLOYEE) @Controller('tables') @JobPermissions('TABLES')
export class TablesController {
  constructor(private readonly tables: TablesService) {}
  @Get() @ApiOperation({ summary: 'Get table grid and availability' }) @ApiResponse({ status: 200, description: 'Tables ordered by table number, including AVAILABLE, OCCUPIED, or RESERVED status.' })
  findAll() { return this.tables.findAll(); }
  @Get(':id') @ApiOperation({ summary: 'Get table by ID' }) @ApiResponse({ status: 200, description: 'Table returned.' }) @ApiNotFoundResponse({ description: 'Table not found.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) { return this.tables.findOne(id); }
  @Patch('layout') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Save all table floor positions and shapes (admin)' }) @ApiResponse({ status: 200, description: 'Floor layout saved atomically.' })
  updateLayout(@Body() dto: UpdateTableLayoutDto) { return this.tables.updateLayout(dto); }
  @Post() @Roles(Role.ADMIN) @ApiOperation({ summary: 'Create a table (admin)' }) @ApiResponse({ status: 201, description: 'Table created.' }) @ApiConflictResponse({ description: 'Table number already exists.' })
  create(@Body() dto: CreateTableDto) { return this.tables.create(dto); }
  @Patch(':id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Update a table (admin)' }) @ApiResponse({ status: 200, description: 'Table updated.' }) @ApiNotFoundResponse({ description: 'Table not found.' }) @ApiConflictResponse({ description: 'Table number already exists.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTableDto) { return this.tables.update(id, dto); }
  @Patch(':id/status') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Set table availability (admin or employee)' }) @ApiResponse({ status: 200, description: 'Table status updated.' }) @ApiNotFoundResponse({ description: 'Table not found.' })
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTableStatusDto) { return this.tables.updateStatus(id, dto); }
  @Patch(':id/room-assignment') @ApiOperation({ summary: 'Assign or clear active guest rooms for a table' }) @ApiResponse({ status: 200, description: 'Table room assignments updated.' }) @ApiConflictResponse({ description: 'One or more selected guest stays are checked out.' })
  assignRoom(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignTableRoomDto) { return this.tables.assignRooms(id, dto.roomStayIds); }
  @Post(':id/checkout') @JobPermissions('ORDER_CREATE') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Settle all served orders on a table by cash or guest room folio' }) @ApiResponse({ status: 201, description: 'Orders settled, table released, and any room folio charges recorded.' }) @ApiConflictResponse({ description: 'Orders are not all served, a room stay is invalid, or an order is already settled.' })
  checkout(@Param('id', ParseUUIDPipe) id: string, @GetUser('id') cashierId: string, @Body() dto: CheckoutTableDto) { return this.tables.checkout(id, cashierId, dto); }
  @Delete(':id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Delete a table without order history (admin)' }) @ApiResponse({ status: 200, description: 'Table deleted.' }) @ApiConflictResponse({ description: 'Table has order history.' }) @ApiNotFoundResponse({ description: 'Table not found.' })
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.tables.remove(id); }
}
