import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { RoomPaymentMethod } from 'prisma/generated/prisma/enums';

export class SettleRoomStayDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() clientRequestId?: string;
  @ApiProperty({ enum: RoomPaymentMethod }) @IsEnum(RoomPaymentMethod) method!: RoomPaymentMethod;
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @MaxLength(200) note?: string;
  @ApiPropertyOptional({ type: [String], description: 'Settle these open bills only. Omit to settle the whole tab.' })
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('4', { each: true }) chargeIds?: string[];
}

export class RemoveChargeLineDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() orderItemId!: string;
  @ApiProperty({ example: 0 }) @Type(() => Number) @IsInt() @Min(0) unit!: number;
  @ApiProperty({ example: 'Guest changed their mind' }) @IsString() @IsNotEmpty() @MaxLength(240) reason!: string;
}

export class UpdateChargeLineQuantityDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() orderItemId!: string;
  @ApiProperty({ example: 0 }) @Type(() => Number) @IsInt() @Min(0) unit!: number;
  @ApiProperty({ example: 2, minimum: 1, maximum: 99 }) @Type(() => Number) @IsInt() @Min(1) @Max(99) quantity!: number;
}

export class UpdateChargeQuantityDto {
  @ApiProperty({ example: 2, minimum: 1, maximum: 99 }) @Type(() => Number) @IsInt() @Min(1) @Max(99) quantity!: number;
}

export class SignRoomChargeDto {
  @ApiProperty({ example: 'Tor' }) @IsString() @IsNotEmpty() @MaxLength(120) signedByName!: string;
  @ApiProperty({ description: 'Data URL of the guest signature' }) @IsString() @IsNotEmpty() @MaxLength(500000) signatureData!: string;
}
