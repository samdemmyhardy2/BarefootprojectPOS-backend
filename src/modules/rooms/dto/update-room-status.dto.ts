import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { RoomStatus } from 'prisma/generated/prisma/enums';

export class UpdateRoomStatusDto {
  @ApiProperty({ enum: [RoomStatus.AVAILABLE, RoomStatus.MAINTENANCE, RoomStatus.ARCHIVED] })
  @IsEnum(RoomStatus)
  status!: RoomStatus;
}
