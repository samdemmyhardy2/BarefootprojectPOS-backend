import { Module } from '@nestjs/common';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';
import { PrintersService } from './printers.service';
import { PrintingController } from './printing.controller';
import { PrintingService } from './printing.service';

@Module({
  controllers: [DiscoveryController, PrintingController],
  providers: [DiscoveryService, PrintersService, PrintingService],
})
export class PrintingModule {}
