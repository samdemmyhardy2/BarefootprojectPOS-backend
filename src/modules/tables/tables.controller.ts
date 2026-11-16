import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
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
import { MoveTablePartyDto } from './dto/move-table-party.dto';
import { SetTableSplitRoomDto } from './dto/set-table-split-room.dto';
import { SettlePartyDto } from './dto/settle-party.dto';
import { SaveBillSplitDto } from './dto/save-bill-split.dto';
import { SettleBillDto } from './dto/settle-bill.dto';
import { AssignBillPayerDto } from './dto/assign-bill-payer.dto';
import { CreateFloorSectionDto } from './dto/create-floor-section.dto';

@ApiTags('Tables') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.ADMIN, Role.EMPLOYEE) @Controller('tables') @JobPermissions('TABLES')
export class TablesController {
  constructor(private readonly tables: TablesService) {}
  @Get() @ApiOperation({ summary: 'Get table grid and availability' }) @ApiResponse({ status: 200, description: 'Tables ordered by table number, including AVAILABLE, OCCUPIED, or RESERVED status.' })
  findAll() { return this.tables.findAll(); }
  @Get('sections') @ApiOperation({ summary: 'List floor sections in display order' }) @ApiResponse({ status: 200, description: 'Named floor sections.' })
  findSections() { return this.tables.findSections(); }
  @Post('sections') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Add a named floor section (admin)' }) @ApiResponse({ status: 201, description: 'Floor section created.' })
  createSection(@Body() dto: CreateFloorSectionDto) { return this.tables.createSection(dto.name); }
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
  @Post(':id/move') @JobPermissions('ORDER_CREATE') @ApiOperation({ summary: 'Move this table’s open orders, open bills, and seated guests to another table' }) @ApiResponse({ status: 201, description: 'The party now sits at the chosen table.' }) @ApiConflictResponse({ description: 'The chosen table already has an open order or bill.' })
  moveParty(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveTablePartyDto) { return this.tables.moveParty(id, dto.tableId); }
  @Post(':id/checkout') @JobPermissions('ORDER_CREATE') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Settle all served orders on a table by cash or guest room folio' }) @ApiResponse({ status: 201, description: 'Orders settled, table released, and any room folio charges recorded.' }) @ApiConflictResponse({ description: 'Orders are not all served, a room stay is invalid, or an order is already settled.' })
  checkout(@Param('id', ParseUUIDPipe) id: string, @GetUser('id') cashierId: string, @Body() dto: CheckoutTableDto) { return this.tables.checkout(id, cashierId, dto); }
  @Post(':id/settle-party') @JobPermissions('ORDER_CREATE') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Settle selected orders for one payer on a table' }) @ApiResponse({ status: 201, description: 'Selected payer orders settled; room folio charges retain the guest signature.' })
  settleParty(@Param('id', ParseUUIDPipe) id: string, @GetUser('id') cashierId: string, @Body() dto: SettlePartyDto) { return this.tables.settleParty(id, cashierId, dto); }
  @Post(':id/splits') @JobPermissions('ORDER_CREATE') @ApiOperation({ summary: 'Split a table into separate sides, or add another side' }) @ApiResponse({ status: 201, description: 'The table now has another side. Existing open orders stay on the first side.' })
  addSplit(@Param('id', ParseUUIDPipe) id: string) { return this.tables.addSplit(id); }
  @Patch(':id/splits/:splitId') @JobPermissions('ORDER_CREATE') @ApiOperation({ summary: 'Remember which guest room is sitting on one side of a split table' })
  setSplitRoom(@Param('id', ParseUUIDPipe) id: string, @Param('splitId', ParseUUIDPipe) splitId: string, @Body() dto: SetTableSplitRoomDto) { return this.tables.setSplitRoom(id, splitId, dto.roomStayId ?? null); }
  @Delete(':id/splits/:splitId') @JobPermissions('ORDER_CREATE') @ApiOperation({ summary: 'Close an empty side of a split table' }) @ApiConflictResponse({ description: 'That side still has an order.' })
  removeSplit(@Param('id', ParseUUIDPipe) id: string, @Param('splitId', ParseUUIDPipe) splitId: string) { return this.tables.removeSplit(id, splitId); }
  @Get(':id/bills') @JobPermissions('ORDER_CREATE') @ApiOperation({ summary: 'List open dishes and split bills for a table' })
  listBills(@Param('id', ParseUUIDPipe) id: string, @Query('splitId') splitId?: string) { return this.tables.listBills(id, splitId || undefined); }
  @Put(':id/bill-split') @JobPermissions('ORDER_CREATE') @ApiOperation({ summary: 'Replace the open split bills for a table' })
  saveBillSplit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveBillSplitDto) { return this.tables.saveBillSplit(id, dto); }
  @Post(':id/bills/:billId/settle') @JobPermissions('ORDER_CREATE') @ApiOperation({ summary: 'Settle one split bill' })
  settleBill(@Param('id', ParseUUIDPipe) id: string, @Param('billId', ParseUUIDPipe) billId: string, @GetUser('id') cashierId: string, @Body() dto: SettleBillDto) { return this.tables.settleBill(id, billId, cashierId, dto); }
  @Patch(':id/bill-payer') @JobPermissions('ORDER_CREATE') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Move open table orders to a checked-in room or back to walk-ins' })
  assignBillPayer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignBillPayerDto) { return this.tables.assignBillPayer(id, dto.orderIds, dto.roomStayId ?? null); }
  @Delete(':id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Delete a table once its open orders are finished (admin)' }) @ApiResponse({ status: 200, description: 'Table deleted. Past orders keep the table name.' }) @ApiConflictResponse({ description: 'The table still has an open order.' }) @ApiNotFoundResponse({ description: 'Table not found.' })
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.tables.remove(id); }
}
