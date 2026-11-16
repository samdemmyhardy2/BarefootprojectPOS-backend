import { Body, Controller, Get, HttpCode, Post, UnauthorizedException, UseGuards, Headers, NotFoundException } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { Role } from 'prisma/generated/prisma/enums';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SyncPushService } from './sync-push.service';
import { SyncReceiveService, type PushedChange } from './sync-receive.service';
import { syncRole } from './sync-tables';

@ApiTags('Server sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('sync')
export class SyncController {
  constructor(private readonly push: SyncPushService) {}

  @Get('status')
  @ApiOperation({ summary: 'Server sync state: reachable, waiting changes, last push (admin only)' })
  status() { return this.push.status(); }

  @Post('run')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ping the server and push waiting changes now (admin only)' })
  run() { return this.push.sync(false); }

  @Post('full')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a full copy so the server matches this laptop exactly (admin only)' })
  full() { return this.push.sync(true); }
}

/** Endpoints the laptop calls on the hosted server. They use the shared SYNC_TOKEN, not a staff sign-in. */
@Controller('sync/receive')
export class SyncReceiveController {
  constructor(private readonly receive: SyncReceiveService) {}

  private authorize(header?: string) {
    if (syncRole() !== 'server') throw new NotFoundException();
    const expected = Buffer.from(`Bearer ${process.env.SYNC_TOKEN?.trim() ?? ''}`);
    const given = Buffer.from(header ?? '');
    if (!process.env.SYNC_TOKEN?.trim() || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedException('Wrong sync token');
  }

  @Get('ping')
  @ApiExcludeEndpoint()
  ping(@Headers('authorization') auth?: string) {
    this.authorize(auth);
    return this.receive.ping();
  }

  @Post('full')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  full(@Headers('authorization') auth: string | undefined, @Body() body: { schema?: string; tables?: { name: string; rows: Record<string, unknown>[] }[] }) {
    this.authorize(auth);
    return this.receive.full(String(body?.schema ?? ''), Array.isArray(body?.tables) ? body.tables : []);
  }

  @Post('changes')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  changes(@Headers('authorization') auth: string | undefined, @Body() body: { schema?: string; changes?: PushedChange[] }) {
    this.authorize(auth);
    return this.receive.changes(String(body?.schema ?? ''), Array.isArray(body?.changes) ? body.changes : []);
  }
}
