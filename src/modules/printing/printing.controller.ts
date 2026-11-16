import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrintReceiptDto, PrintSlipDto, SavePrinterDto, UpdatePrinterDto } from './dto/printing.dto';
import { PrintersService } from './printers.service';
import { PrintingService } from './printing.service';

@ApiTags('Printing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('printing')
export class PrintingController {
  constructor(private readonly printers: PrintersService, private readonly printing: PrintingService) {}

  @Get('status')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Saved printer summary and whether dry-run is forced' })
  status() { return this.printing.status(); }

  @Get('printers')
  @ApiOperation({ summary: 'Saved printers' })
  list() { return this.printers.list(); }

  @Get('printers/:id')
  @ApiOperation({ summary: 'One saved printer' })
  get(@Param('id', ParseUUIDPipe) id: string) { return this.printers.get(id); }

  @Post('printers')
  @ApiOperation({ summary: 'Save a discovered printer. This does not change the printer IP on the device.' })
  create(@Body() dto: SavePrinterDto) { return this.printers.create(dto); }

  @Patch('printers/:id')
  @ApiOperation({ summary: 'Update a saved printer. A scan that misses a printer never changes this record.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePrinterDto) { return this.printers.update(id, dto); }

  @Delete('printers/:id')
  @ApiOperation({ summary: 'Remove a saved printer' })
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.printers.remove(id); }

  @Patch('printers/:id/default')
  @ApiOperation({ summary: 'Use this printer for receipts when no printer is chosen' })
  makeDefault(@Param('id', ParseUUIDPipe) id: string) { return this.printers.makeDefault(id); }

  @Post('printers/:id/test-connection')
  @ApiOperation({ summary: 'Open TCP to the saved printer. Does not print.' })
  testConnection(@Param('id', ParseUUIDPipe) id: string) { return this.printing.testConnection(id); }

  @Post('printers/:id/test-print')
  @ApiOperation({ summary: 'Send a short ESC/POS test slip to the saved printer' })
  testPrint(@Param('id', ParseUUIDPipe) id: string) { return this.printing.testPrint(id); }

  @Post('slips/preview')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Preview one receipt. Text stays text and only the logo and signature are images. Does not print.' })
  previewSlip(@Body() dto: PrintSlipDto) {
    return this.printing.previewSlip(dto);
  }

  @Post('slips')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Print one on-screen receipt image. A room folio is a single slip, not one slip per order.' })
  printSlip(@GetUser() user: { id?: string; sub?: string }, @Body() dto: PrintSlipDto) {
    return this.printing.printSlip(user.id || user.sub || '', dto);
  }

  @Get('receipts/:orderId/preview')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Render the thermal receipt PNG from the order stored in the database' })
  preview(@Param('orderId', ParseUUIDPipe) orderId: string) { return this.printing.preview(orderId); }

  @Post('receipts/:orderId')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Render and send the stored order receipt to a saved printer' })
  print(@Param('orderId', ParseUUIDPipe) orderId: string, @GetUser() user: { id?: string; sub?: string }, @Body() dto: PrintReceiptDto) {
    return this.printing.print(orderId, user.id || user.sub || '', dto);
  }

  @Get('jobs/:jobId')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Print job status. Sent means the socket accepted the bytes, not that paper was confirmed.' })
  job(@Param('jobId', ParseUUIDPipe) jobId: string) { return this.printing.job(jobId); }

  @Post('jobs/:jobId/retry')
  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Retry a failed job once the printer is back. Completed jobs are not sent again.' })
  retry(@Param('jobId', ParseUUIDPipe) jobId: string) { return this.printing.retry(jobId); }
}
