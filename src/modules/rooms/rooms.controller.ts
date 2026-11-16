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
import { AssignRoomStayDto } from './dto/assign-room-stay.dto';
import { RemoveChargeLineDto, SettleRoomStayDto, SignRoomChargeDto, UpdateChargeLineQuantityDto, UpdateChargeQuantityDto } from './dto/settle-room-stay.dto';
import { CloudbedsCalendarQueryDto } from './dto/cloudbeds-calendar-query.dto';
import { CloudbedsRoomActionDto } from './dto/cloudbeds-room-action.dto';
import { CloudbedsService } from './cloudbeds.service';
import { ReservationMailService } from './reservation-mail.service';
import { RoomsService } from './rooms.service';

@ApiTags('Rooms') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Controller('rooms') @JobPermissions('ROOM_VIEW')
export class RoomsController {
  constructor(private readonly rooms: RoomsService, private readonly cloudbeds: CloudbedsService, private readonly mail: ReservationMailService) {}

  @Get('cloudbeds/calendar') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Cloudbeds room calendar for a date range' })
  cloudbedsCalendar(@Query() query: CloudbedsCalendarQueryDto) { return this.cloudbeds.calendar(query.from, query.to); }

  @JobPermissions('ROOM_MANAGE')
  @Post('cloudbeds/check-in') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Check a Cloudbeds reservation room in' })
  cloudbedsCheckIn(@Body() dto: CloudbedsRoomActionDto) { return this.cloudbeds.checkIn(dto); }

  @JobPermissions('ROOM_MANAGE')
  @Post('cloudbeds/check-out') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Check a Cloudbeds reservation room out' })
  cloudbedsCheckOut(@Body() dto: CloudbedsRoomActionDto) { return this.cloudbeds.checkOut(dto); }

  @Get('calendar') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Local room calendar for a date range' })
  calendar(@Query() query: CloudbedsCalendarQueryDto) { return this.rooms.calendar(query.from, query.to); }

  @Get('email-imports') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Imported Cloudbeds emails. Mailbox credentials are not included.' })
  emailImports(@Query('messageId') messageId?: string, @Query('confirmation') confirmation?: string, @Query('cloudbedsId') cloudbedsId?: string, @Query('guest') guest?: string, @Query('kind') kind?: string, @Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return Promise.all([this.mail.status(), this.mail.history({ messageId, confirmation, cloudbedsId, guest, kind, status, from, to }), this.mail.runs()]).then(([summary, messages, runs]) => ({ ...summary, messages, sync: runs }));
  }

  @Get('email-sync-runs') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Cloudbeds mailbox synchronization runs' })
  emailSyncRuns() { return this.mail.runs(); }

  @Get('email-imports/:id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'One stored reservation email, including the original message' })
  emailImport(@Param('id', ParseUUIDPipe) id: string) { return this.mail.detail(id); }

  @Post('email-imports/poll') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Read new forwarded reservation emails from the existing mailbox' })
  pollEmailImports() { return this.mail.poll(); }

  @Post('email-imports/backfill') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Import the full Cloudbeds history already in the mailbox, including read mail' })
  backfillEmailImports() { return this.mail.backfill(); }

  @Post('email-imports/:id/retry') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Queue one failed or skipped reservation email for another attempt' })
  retryEmailImport(@Param('id', ParseUUIDPipe) id: string) { return this.mail.retry(id); }

  @Get() @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'List rooms and current guests' }) @ApiResponse({ status: 200, description: 'Room list and active stay details.' })
  findAll() { return this.rooms.findAll(); }

  @Get('commission-items') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Commission items that can be added to a room bill' })
  commissionItems() { return this.rooms.commissionItems(); }

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

  @Get('stays/:stayId/room-choices') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Rooms that can take an unassigned reservation' }) @ApiNotFoundResponse({ description: 'Room stay not found.' })
  roomChoices(@Param('stayId', ParseUUIDPipe) stayId: string) { return this.rooms.roomChoices(stayId); }

  @JobPermissions('ROOM_MANAGE')
  @Post('stays/:stayId/assign') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Assign a reservation to a room, or move it onto another room' }) @ApiNotFoundResponse({ description: 'Room stay or room not found.' }) @ApiConflictResponse({ description: 'The reservation is cancelled or checked out, or the room is booked or unavailable for these dates.' })
  assignRoom(@Param('stayId', ParseUUIDPipe) stayId: string, @Body() dto: AssignRoomStayDto) { return this.rooms.assignRoom(stayId, dto.roomId); }

  @JobPermissions('ROOM_FOLIO')
  @Patch('stays/:stayId') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Update active guest stay details and folio policies' }) @ApiNotFoundResponse({ description: 'Room stay not found.' })
  updateStay(@Param('stayId', ParseUUIDPipe) stayId: string, @Body() dto: UpdateRoomStayDto) { return this.rooms.updateStay(stayId, dto); }

  @JobPermissions('ROOM_FOLIO')
  @Post('stays/:stayId/settle') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Settle the room tab, or selected bills, and keep the guest stay open' }) @ApiResponse({ status: 201, description: 'Paid room folio and settlement details.' }) @ApiConflictResponse({ description: 'There is no open balance, a selected bill is already settled, or the stay is closed.' })
  settle(@Param('stayId', ParseUUIDPipe) stayId: string, @GetUser('id') cashierId: string, @Body() dto: SettleRoomStayDto) { return this.rooms.settle(stayId, cashierId, dto); }

  @JobPermissions('ROOM_FOLIO')
  @Patch('charges/:chargeId/signature') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Add the guest signature to an unsigned room-tab charge' }) @ApiNotFoundResponse({ description: 'Charge not found.' })
  signCharge(@Param('chargeId', ParseUUIDPipe) chargeId: string, @Body() dto: SignRoomChargeDto) { return this.rooms.signCharge(chargeId, dto); }

  @JobPermissions('ROOM_FOLIO')
  @Patch('charges/:chargeId/lines/remove') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Remove one dish from an open room bill and keep it on the bill with the reason' }) @ApiConflictResponse({ description: 'The bill is already settled.' })
  removeChargeLine(@Param('chargeId', ParseUUIDPipe) chargeId: string, @Body() dto: RemoveChargeLineDto) { return this.rooms.removeChargeLine(chargeId, dto); }

  @JobPermissions('ROOM_FOLIO')
  @Patch('charges/:chargeId/lines/quantity') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Change how many of one dish are on an open room bill' }) @ApiConflictResponse({ description: 'The bill is already settled or the new quantity would pass the guest charge limit.' })
  updateChargeLineQuantity(@Param('chargeId', ParseUUIDPipe) chargeId: string, @Body() dto: UpdateChargeLineQuantityDto) { return this.rooms.updateChargeLineQuantity(chargeId, dto); }

  @JobPermissions('ROOM_FOLIO')
  @Patch('charges/:chargeId/quantity') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Change the quantity of an open room charge that is not a restaurant dish' }) @ApiConflictResponse({ description: 'The charge is already settled or the new quantity would pass the guest charge limit.' })
  updateChargeQuantity(@Param('chargeId', ParseUUIDPipe) chargeId: string, @Body() dto: UpdateChargeQuantityDto) { return this.rooms.updateChargeQuantity(chargeId, dto.quantity); }

  @JobPermissions('ROOM_FOLIO')
  @Patch('charges/:chargeId/items/:itemId/quantity') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Change the quantity of a dish on an open room order' }) @ApiConflictResponse({ description: 'The bill is already settled or the new quantity would pass the guest charge limit.' })
  updateChargedItemQuantity(@Param('chargeId', ParseUUIDPipe) chargeId: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: UpdateChargeQuantityDto) { return this.rooms.updateChargedItemQuantity(chargeId, itemId, dto.quantity); }

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
