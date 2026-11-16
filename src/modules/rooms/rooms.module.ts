import { Module } from '@nestjs/common';
import { CloudbedsService } from './cloudbeds.service';
import { ReservationMailService } from './reservation-mail.service';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({ controllers: [RoomsController], providers: [RoomsService, CloudbedsService, ReservationMailService] })
export class RoomsModule {}
