import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Delete,
  Query,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { Observable, interval, map } from 'rxjs';
import { JwtService } from '@nestjs/jwt';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiConflictResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { CreateOrderDto, RemoveOrderItemDto, SetKitchenFlagDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { JobPermissions } from 'src/common/decorators/job-permissions.decorator';
import { GetUser } from 'src/common/decorators/get-user.decorator';
import { PrepStation, Role } from 'prisma/generated/prisma/enums';
import { AcceptStreamToken } from 'src/common/decorators/stream-token.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { OrderPageQueryDto } from './dto/order-page-query.dto';
import { CreateCommissionItemDto } from './dto/create-commission-item.dto';
import { RedirectPrepTicketDto } from './dto/redirect-prep-ticket.dto';

@ApiTags('Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService, private readonly jwtService: JwtService) { }

  @JobPermissions('ORDER_CREATE')
  @Get('active-room-stays')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'List active guest rooms available for checkout billing on an order' })
  @ApiResponse({ status: 200, description: 'Active stay IDs, guest names, and room numbers for order billing.' })
  activeRoomStays() { return this.ordersService.activeRoomStays(); }

  @JobPermissions('ORDER_CREATE')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({
    summary: 'Create a new customer order',
    description:
      'Creates a restaurant or room-service order, optionally posting it to an active guest room folio for checkout.',
  })
  @ApiResponse({
    status: 201,
    description: 'Order created successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Validation failed or order contains no items.',
  })
  @ApiNotFoundResponse({
    description: 'Table or one of the specified menu items was not found.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication token missing or invalid.' })
  @ApiForbiddenResponse({ description: 'User does not have permission to place orders.' })
  create(
    @GetUser('id') waiterId: string,
    @Body() createOrderDto: CreateOrderDto,
  ) {
    return this.ordersService.create(waiterId, createOrderDto);
  }

  @JobPermissions('ORDER_CREATE')
  @Patch(':id/items/:itemId/kitchen-flag')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Mark or clear the kitchen comment icon for one dish' })
  @ApiParam({ name: 'id', description: 'Order id' })
  @ApiParam({ name: 'itemId', description: 'Order line id' })
  setKitchenFlag(@Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: SetKitchenFlagDto) {
    return this.ordersService.setKitchenFlag(id, itemId, dto.flagged);
  }

  @JobPermissions('ORDER_CREATE')
  @Delete(':id/items/:itemId')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Remove one dish that was sent to the table by mistake' })
  @ApiParam({ name: 'id', description: 'Order id' })
  @ApiParam({ name: 'itemId', description: 'Order line id' })
  @ApiConflictResponse({ description: 'The dish is already paid or on a settled bill.' })
  removeItem(@Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.ordersService.removeItem(id, itemId);
  }

  @JobPermissions('ORDER_CREATE')
  @Patch(':id/items/:itemId/remove')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Remove one dish from a room order and keep it on the order with the reason' })
  @ApiParam({ name: 'id', description: 'Order id' })
  @ApiParam({ name: 'itemId', description: 'Order line id' })
  voidItem(@Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: RemoveOrderItemDto) {
    return this.ordersService.voidItem(id, itemId, dto.reason);
  }

  @JobPermissions('ORDER_VIEW')
  @Get()
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({
    summary: 'Retrieve all orders',
    description:
      'Fetches a list of all orders sorted by creation date (newest first), including table details, items, menu details, and waiter info.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of orders retrieved successfully.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication token missing or invalid.' })
  findAll() {
    return this.ordersService.findAll();
  }

  @JobPermissions('ORDER_VIEW')
  @Get('page')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Get a page of orders filtered by date, status, payment, or place, plus date sales for total, room, and cash' })
  @ApiResponse({ status: 200, description: 'Orders and pagination metadata.' })
  findPage(@Query() query: OrderPageQueryDto) {
    return this.ordersService.findPage(query);
  }

  @JobPermissions('ORDER_VIEW')
  @Get('commission-items')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'List commission items such as a speed boat transfer' })
  commissionItems() { return this.ordersService.commissionItems(); }

  @JobPermissions('ORDER_VIEW')
  @Post('commission-items')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Add a commission item. The guest pays the price. The daily report shows only the commission.' })
  @ApiBadRequestResponse({ description: 'The commission is higher than the guest price, or the name is empty.' })
  createCommissionItem(@Body() dto: CreateCommissionItemDto) { return this.ordersService.createCommissionItem(dto); }

  @JobPermissions('ORDER_SERVE')
  @Get('ready')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Get orders ready for wait staff to collect' })
  @ApiResponse({ status: 200, description: 'Ready orders sorted oldest first.' })
  readyOrders() { return this.ordersService.readyOrders(); }

  @JobPermissions('ORDER_CREATE')
  @Get('pickup')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'List active pickup orders for the employee pickup counter' })
  @ApiResponse({ status: 200, description: 'Pickup orders from kitchen preparation through customer collection.' })
  pickupOrders() { return this.ordersService.pickupOrders(); }

  @JobPermissions('ORDER_CREATE')
  @Patch(':id/pickup/complete')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Record cash payment and hand a ready pickup order to the customer' })
  @ApiResponse({ status: 200, description: 'Pickup order marked completed and paid by cash.' })
  @ApiNotFoundResponse({ description: 'Pickup order not found.' })
  acknowledgePickup(@Param('id', ParseUUIDPipe) id: string, @GetUser('id') employeeId: string) {
    return this.ordersService.completePickup(id, employeeId);
  }

  @JobPermissions('ORDER_VIEW')
  @Get('events/token')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Create a short-lived token for a browser order event stream' })
  @ApiResponse({ status: 200, description: 'A stream token valid for 15 minutes.' })
  async createStreamToken(@GetUser() user: { id: string; role: Role; jobTitle: string }): Promise<{ streamToken: string; expiresInSeconds: number }> {
    const streamToken = await this.jwtService.signAsync(
      { id: user.id, sub: user.id, role: user.role, jobTitle: user.jobTitle, scope: 'orders:stream' },
      { secret: process.env.JWT_SECRET || 'super-secret-key', expiresIn: '15m' },
    );
    return { streamToken, expiresInSeconds: 900 };
  }

  @JobPermissions('ORDER_VIEW')
  @Sse('events')
  @AcceptStreamToken()
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiQuery({ name: 'streamToken', required: true, description: 'Short-lived token returned by GET /orders/events/token.' })
  @ApiOperation({ summary: 'Subscribe to live order changes; sends a snapshot then created, updated, and deleted events' })
  events(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let snapshotSent = false;
      const buffered: Array<{ type: 'created' | 'updated' | 'deleted'; order: object | string }> = [];
      const eventSubscription = this.ordersService.events().subscribe((event) => {
        if (!snapshotSent) buffered.push(event);
        else subscriber.next({ type: event.type, data: event.order });
      });
      const heartbeatSubscription = interval(20_000).subscribe(() => {
        subscriber.next({ type: 'heartbeat', data: { at: new Date().toISOString() } });
      });
      void this.ordersService.liveSnapshot().then((snapshot) => {
        if (subscriber.closed) return;
        subscriber.next({ type: 'snapshot', data: snapshot });
        snapshotSent = true;
        for (const event of buffered) subscriber.next({ type: event.type, data: event.order });
        buffered.length = 0;
      }).catch((error: unknown) => subscriber.error(error));
      return () => {
        eventSubscription.unsubscribe();
        heartbeatSubscription.unsubscribe();
      };
    });
  }

  @JobPermissions('ORDER_VIEW')
  @Get(':id')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({
    summary: 'Get order details by ID',
    description:
      'Retrieves complete detail for a single order including item customizations, table number, and assigned employee.',
  })
  @ApiParam({
    name: 'id',
    description: 'Order UUID',
    type: String,
    example: 'c2d3e4f5-6789-01ab-cdef-234567890abc',
  })
  @ApiResponse({
    status: 200,
    description: 'Order details retrieved successfully.',
  })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  @ApiUnauthorizedResponse({ description: 'Authentication token missing or invalid.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.findOne(id);
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Update order status',
    description:
      'Updates the status of an order. If set to COMPLETED or CANCELLED, automatically releases the table status back to AVAILABLE in a batch transaction.',
  })
  @ApiParam({
    name: 'id',
    description: 'Order UUID',
    type: String,
    example: 'c2d3e4f5-6789-01ab-cdef-234567890abc',
  })
  @ApiResponse({
    status: 200,
    description: 'Order status updated successfully.',
  })
  @ApiBadRequestResponse({ description: 'Invalid status value provided.' })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  @ApiUnauthorizedResponse({ description: 'Authentication token missing or invalid.' })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateOrderStatusDto: UpdateOrderStatusDto,
    @GetUser('id') actorId: string,
  ) {
    return this.ordersService.updateStatus(id, updateOrderStatusDto, actorId);
  }

  @Public()
  @Get('kitchen/prep-queue')
  prepKitchenQueue() { return this.ordersService.prepQueue(PrepStation.KITCHEN); }

  @JobPermissions('BAR')
  @Get('bar/prep-queue')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  prepBarQueue() { return this.ordersService.prepQueue(PrepStation.BAR); }

  @JobPermissions('ORDER_VIEW')
  @Patch('prep-tickets/:ticketId/redirect')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Redirect a pending prep ticket to the other station' })
  redirectPrepTicket(@Param('ticketId', ParseUUIDPipe) ticketId: string, @Body() dto: RedirectPrepTicketDto) {
    return this.ordersService.redirectPrepTicket(ticketId, dto.station);
  }

  @JobPermissions('KITCHEN')
  @Patch('kitchen/tickets/:ticketId/prepare')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  prepareKitchenTicket(@Param('ticketId', ParseUUIDPipe) ticketId: string) { return this.ordersService.updatePrepTicket(ticketId, PrepStation.KITCHEN, 'prepare'); }

  @JobPermissions('KITCHEN')
  @Patch('kitchen/tickets/:ticketId/ready')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  readyKitchenTicket(@Param('ticketId', ParseUUIDPipe) ticketId: string) { return this.ordersService.updatePrepTicket(ticketId, PrepStation.KITCHEN, 'ready'); }

  @Public()
  @Patch('kitchen/tickets/:ticketId/pickup')
  @ApiOperation({ summary: 'Pick up a kitchen ticket from the open kitchen display' })
  pickupKitchenTicket(@Param('ticketId', ParseUUIDPipe) ticketId: string, @GetUser('id') servedById?: string) {
    return this.ordersService.pickupKitchenTicket(ticketId, servedById ?? null);
  }

  @Public()
  @Patch('kitchen/orders/:id/pickup')
  @ApiOperation({ summary: 'Pick up a kitchen order from the open kitchen display' })
  pickupKitchenOrder(@Param('id', ParseUUIDPipe) id: string, @GetUser('id') servedById?: string) {
    return this.ordersService.pickupKitchenOrder(id, servedById ?? null);
  }

  @JobPermissions('BAR')
  @Patch('bar/tickets/:ticketId/prepare')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  prepareBarTicket(@Param('ticketId', ParseUUIDPipe) ticketId: string) { return this.ordersService.updatePrepTicket(ticketId, PrepStation.BAR, 'prepare'); }

  @JobPermissions('BAR')
  @Patch('bar/tickets/:ticketId/ready')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  readyBarTicket(@Param('ticketId', ParseUUIDPipe) ticketId: string) { return this.ordersService.updatePrepTicket(ticketId, PrepStation.BAR, 'ready'); }

  @JobPermissions('KITCHEN')
  @Get('cook/queue')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Get pending and in-progress orders for the kitchen' })
  @ApiResponse({ status: 200, description: 'Kitchen queue sorted oldest first.' })
  cookQueue() { return this.ordersService.cookQueue(); }

  @JobPermissions('KITCHEN')
  @Patch(':id/prepare')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Accept an order and start preparing it' })
  @ApiResponse({ status: 200, description: 'Order moved from PENDING to PREPARING.' })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  prepare(@Param('id', ParseUUIDPipe) id: string) { return this.ordersService.cookStart(id); }

  @JobPermissions('KITCHEN')
  @Patch(':id/ready')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Mark a prepared order ready for collection' })
  @ApiResponse({ status: 200, description: 'Order moved from PREPARING to READY.' })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  markReady(@Param('id', ParseUUIDPipe) id: string) { return this.ordersService.cookReady(id); }

  @JobPermissions('ORDER_SERVE')
  @Patch(':id/served')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Acknowledge a ready order and mark it served' })
  @ApiResponse({ status: 200, description: 'Order moved from READY to SERVED.' })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  acknowledgeReady(@Param('id', ParseUUIDPipe) id: string, @GetUser('id') servedById: string) { return this.ordersService.acknowledgeReady(id, servedById); }

  @JobPermissions('ORDER_SERVE')
  @Patch(':id/revert')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Undo pickup and return a served order to ready' })
  @ApiResponse({ status: 200, description: 'Order moved from SERVED back to READY.' })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  revertReady(@Param('id', ParseUUIDPipe) id: string) { return this.ordersService.revertReady(id); }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete an order (admin)' })
  @ApiResponse({ status: 200, description: 'Order deleted.' })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.ordersService.remove(id); }
}
