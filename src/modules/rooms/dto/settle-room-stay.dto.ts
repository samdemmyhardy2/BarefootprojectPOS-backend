import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { RoomPaymentMethod } from 'prisma/generated/prisma/enums';

export class SettleRoomStayDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() clientRequestId?: string;
  @ApiProperty({ enum: RoomPaymentMethod }) @IsEnum(RoomPaymentMethod) method!: RoomPaymentMethod;
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @MaxLength(200) note?: string;
  @ApiPropertyOptional({ type: [String], description: 'Settle these open bills only. Omit to settle the whole tab.' })
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('4', { each: true }) chargeIds?: string[];
}
