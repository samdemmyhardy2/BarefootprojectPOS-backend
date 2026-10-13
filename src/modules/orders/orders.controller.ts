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
  ApiQuery,
} from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { GetUser } from 'src/common/decorators/get-user.decorator';
import { Role } from 'prisma/generated/prisma/enums';
import { AcceptStreamToken } from 'src/common/decorators/stream-token.decorator';

@ApiTags('Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService, private readonly jwtService: JwtService) { }

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

  @Get('ready')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Get orders ready for wait staff to collect' })
  @ApiResponse({ status: 200, description: 'Ready orders sorted oldest first.' })
  readyOrders() { return this.ordersService.readyOrders(); }

  @Get('events/token')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Create a short-lived token for a browser order event stream' })
  @ApiResponse({ status: 200, description: 'A stream token valid for 15 minutes.' })
  async createStreamToken(@GetUser() user: { id: string; role: Role }): Promise<{ streamToken: string; expiresInSeconds: number }> {
    const streamToken = await this.jwtService.signAsync(
      { id: user.id, sub: user.id, role: user.role, scope: 'orders:stream' },
      { secret: process.env.JWT_SECRET || 'super-secret-key', expiresIn: '15m' },
    );
    return { streamToken, expiresInSeconds: 900 };
  }

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
  ) {
    return this.ordersService.updateStatus(id, updateOrderStatusDto);
  }

  @Get('cook/queue')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Get pending and in-progress orders for the kitchen' })
  @ApiResponse({ status: 200, description: 'Kitchen queue sorted oldest first.' })
  cookQueue() { return this.ordersService.cookQueue(); }

  @Patch(':id/prepare')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Accept an order and start preparing it' })
  @ApiResponse({ status: 200, description: 'Order moved from PENDING to PREPARING.' })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  prepare(@Param('id', ParseUUIDPipe) id: string) { return this.ordersService.cookStart(id); }

  @Patch(':id/ready')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Mark a prepared order ready for collection' })
  @ApiResponse({ status: 200, description: 'Order moved from PREPARING to READY.' })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  markReady(@Param('id', ParseUUIDPipe) id: string) { return this.ordersService.cookReady(id); }

  @Patch(':id/served')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Acknowledge a ready order and mark it served' })
  @ApiResponse({ status: 200, description: 'Order moved from READY to SERVED.' })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  acknowledgeReady(@Param('id', ParseUUIDPipe) id: string) { return this.ordersService.acknowledgeReady(id); }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete an order (admin)' })
  @ApiResponse({ status: 200, description: 'Order deleted.' })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.ordersService.remove(id); }
}
