import { Module } from '@nestjs/common';
import { CloudbedsService } from './cloudbeds.service';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({ controllers: [RoomsController], providers: [RoomsService, CloudbedsService] })
export class RoomsModule {}
