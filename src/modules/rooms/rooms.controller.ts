import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CheckInRoomDto } from './dto/check-in-room.dto';
import { CreateRoomChargeDto } from './dto/create-room-charge.dto';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { RoomsService } from './rooms.service';

@ApiTags('Rooms') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get() @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'List rooms and current guests' }) @ApiResponse({ status: 200, description: 'Room list and active stay details.' })
  findAll() { return this.rooms.findAll(); }

  @Post() @Roles(Role.ADMIN) @ApiOperation({ summary: 'Create a room' }) @ApiResponse({ status: 201, description: 'Room created.' }) @ApiConflictResponse({ description: 'Room number already exists.' })
  create(@Body() dto: CreateRoomDto) { return this.rooms.create(dto); }

  @Patch(':id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Update room size, number, or usage fee' }) @ApiNotFoundResponse({ description: 'Room not found.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoomDto) { return this.rooms.update(id, dto); }

  @Delete(':id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Delete a room with no stay history' }) @ApiConflictResponse({ description: 'Room has stay history.' })
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.rooms.remove(id); }

  @Post(':id/check-in') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Check guests into a room and record its usage fee' }) @ApiResponse({ status: 201, description: 'Guest stay created with occupants and room fee.' }) @ApiConflictResponse({ description: 'Room is already occupied.' })
  checkIn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CheckInRoomDto) { return this.rooms.checkIn(id, dto); }

  @Post('stays/:stayId/charges') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Record water, food, or other room usage on the guest folio' }) @ApiBadRequestResponse({ description: 'Invalid or automatically-managed charge type.' })
  addCharge(@Param('stayId', ParseUUIDPipe) stayId: string, @Body() dto: CreateRoomChargeDto) { return this.rooms.addCharge(stayId, dto); }

  @Get(':id/stays') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'List current and past room stays' }) @ApiResponse({ status: 200, description: 'Room stay history with folio entries and restaurant orders.' }) @ApiNotFoundResponse({ description: 'Room not found.' })
  history(@Param('id', ParseUUIDPipe) id: string) { return this.rooms.history(id); }

  @Get('stays/:stayId/timeline') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Get a room stay timeline, folio charges, and restaurant orders' }) @ApiNotFoundResponse({ description: 'Room stay not found.' })
  timeline(@Param('stayId', ParseUUIDPipe) stayId: string) { return this.rooms.timeline(stayId); }

  @Post('stays/:stayId/check-out') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Check out guests and close the room folio' }) @ApiResponse({ status: 201, description: 'Checkout summary with a timeline and total amount due.' }) @ApiConflictResponse({ description: 'Guest has already checked out.' })
  checkOut(@Param('stayId', ParseUUIDPipe) stayId: string) { return this.rooms.checkOut(stayId); }
}
