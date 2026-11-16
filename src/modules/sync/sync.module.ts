import { Module } from '@nestjs/common';
import { SyncController, SyncReceiveController } from './sync.controller';
import { SyncPushService } from './sync-push.service';
import { SyncReceiveService } from './sync-receive.service';

@Module({ controllers: [SyncController, SyncReceiveController], providers: [SyncPushService, SyncReceiveService] })
export class SyncModule {}
