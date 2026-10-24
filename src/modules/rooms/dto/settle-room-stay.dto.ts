import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { RoomPaymentMethod } from 'prisma/generated/prisma/enums';

export class SettleRoomStayDto {
  @ApiProperty({ enum: RoomPaymentMethod }) @IsEnum(RoomPaymentMethod) method!: RoomPaymentMethod;
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @MaxLength(200) note?: string;
}
