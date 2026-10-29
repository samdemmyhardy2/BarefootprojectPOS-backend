import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { Roles } from '../../common/decorators/roles.decorator';
import { JobPermissions } from '../../common/decorators/job-permissions.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CheckInRoomDto } from './dto/check-in-room.dto';
import { CreateRoomChargeDto } from './dto/create-room-charge.dto';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { UpdateRoomStatusDto } from './dto/update-room-status.dto';
import { UpdateRoomStayDto } from './dto/update-room-stay.dto';
import { SettleRoomStayDto } from './dto/settle-room-stay.dto';
import { RoomsService } from './rooms.service';

@ApiTags('Rooms') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Controller('rooms') @JobPermissions('ROOM_VIEW')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get() @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'List rooms and current guests' }) @ApiResponse({ status: 200, description: 'Room list and active stay details.' })
  findAll() { return this.rooms.findAll(); }

  @Post() @Roles(Role.ADMIN) @ApiOperation({ summary: 'Create a room' }) @ApiResponse({ status: 201, description: 'Room created.' }) @ApiConflictResponse({ description: 'Room number already exists.' })
  create(@Body() dto: CreateRoomDto) { return this.rooms.create(dto); }

  @Patch(':id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Update a room number' }) @ApiNotFoundResponse({ description: 'Room not found.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoomDto) { return this.rooms.update(id, dto); }

  @Patch(':id/status') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Set a room available, under maintenance, or archived' }) @ApiBadRequestResponse({ description: 'Room status cannot be set to OCCUPIED manually.' }) @ApiConflictResponse({ description: 'Check out active guests before changing room status.' })
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoomStatusDto) { return this.rooms.updateStatus(id, dto.status); }

  @Delete(':id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Delete an empty room, or permanently delete the room and all stay history' }) @ApiQuery({ name: 'deleteHistory', required: false, type: Boolean, description: 'Set true to permanently remove guest stays, charges, and linked room-service tickets.' }) @ApiConflictResponse({ description: 'Room has active guests or stay history requiring explicit deletion.' })
  remove(@Param('id', ParseUUIDPipe) id: string, @Query('deleteHistory') deleteHistory?: string) { return this.rooms.remove(id, deleteHistory === 'true'); }

  @JobPermissions('ROOM_MANAGE')
  @Post(':id/check-in') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Check guests into a room' }) @ApiResponse({ status: 201, description: 'Guest stay created with occupants.' }) @ApiConflictResponse({ description: 'Room is already occupied.' })
  checkIn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CheckInRoomDto) { return this.rooms.checkIn(id, dto); }

  @JobPermissions('ROOM_FOLIO')
  @Patch('stays/:stayId') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Update active guest stay details and folio policies' }) @ApiNotFoundResponse({ description: 'Room stay not found.' })
  updateStay(@Param('stayId', ParseUUIDPipe) stayId: string, @Body() dto: UpdateRoomStayDto) { return this.rooms.updateStay(stayId, dto); }

  @JobPermissions('ROOM_FOLIO')
  @Post('stays/:stayId/settle') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Settle the room tab, or selected bills, and keep the guest stay open' }) @ApiResponse({ status: 201, description: 'Paid room folio and settlement details.' }) @ApiConflictResponse({ description: 'There is no open balance, a selected bill is already settled, or the stay is closed.' })
  settle(@Param('stayId', ParseUUIDPipe) stayId: string, @GetUser('id') cashierId: string, @Body() dto: SettleRoomStayDto) { return this.rooms.settle(stayId, cashierId, dto); }

  @JobPermissions('ROOM_FOLIO')
  @Post('stays/:stayId/charges') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Record water, food, or other room usage on the guest folio' }) @ApiBadRequestResponse({ description: 'Invalid or automatically-managed charge type.' })
  addCharge(@Param('stayId', ParseUUIDPipe) stayId: string, @Body() dto: CreateRoomChargeDto) { return this.rooms.addCharge(stayId, dto); }

  @Get(':id/stays') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'List current and past room stays' }) @ApiResponse({ status: 200, description: 'Room stay history with folio entries and restaurant orders.' }) @ApiNotFoundResponse({ description: 'Room not found.' })
  history(@Param('id', ParseUUIDPipe) id: string) { return this.rooms.history(id); }

  @Get('stays/:stayId/timeline') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Get a room stay timeline, folio charges, and restaurant orders' }) @ApiNotFoundResponse({ description: 'Room stay not found.' })
  timeline(@Param('stayId', ParseUUIDPipe) stayId: string) { return this.rooms.timeline(stayId); }

  @JobPermissions('ROOM_FOLIO')
  @Post('stays/:stayId/check-out') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Check out guests and close the room folio' }) @ApiResponse({ status: 201, description: 'Checkout summary with a timeline and total amount due.' }) @ApiConflictResponse({ description: 'Guest has already checked out.' })
  checkOut(@Param('stayId', ParseUUIDPipe) stayId: string) { return this.rooms.checkOut(stayId); }
}
