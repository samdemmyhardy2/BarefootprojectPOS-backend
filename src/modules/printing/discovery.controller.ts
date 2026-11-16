import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { DiscoveryService } from './discovery.service';
import { ScanNetworkDto } from './dto/printing.dto';
import { isPrivateIpv4 } from './network';

@ApiTags('Network discovery')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('network/discovery')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Post('scan')
  @ApiOperation({ summary: 'Scan the private LAN for devices. Results are cached until the next scan.' })
  scan(@Body() dto: ScanNetworkDto) {
    return this.discovery.start(dto).catch((error: unknown) => {
      throw new BadRequestException(error instanceof Error ? error.message : 'Unable to scan the network');
    });
  }

  @Get('results')
  @ApiOperation({ summary: 'Latest LAN scan, including progress while a scan is running' })
  results() { return this.discovery.results(); }

  @Get('printers')
  @ApiOperation({ summary: 'Printers found by the latest scan' })
  printers() { return this.discovery.printers(); }

  @Get('devices/:ip')
  @ApiOperation({ summary: 'One device from the latest scan' })
  device(@Param('ip') ip: string) {
    if (!isPrivateIpv4(ip)) throw new BadRequestException('Only private LAN addresses can be inspected');
    const device = this.discovery.device(ip);
    if (!device) throw new NotFoundException('That address was not in the latest scan');
    return device;
  }
}
