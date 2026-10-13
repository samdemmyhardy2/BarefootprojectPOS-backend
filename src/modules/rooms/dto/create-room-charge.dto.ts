import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNumber, IsString, Max, MaxLength, Min } from 'class-validator';
import { RoomChargeKind } from 'prisma/generated/prisma/enums';

export class CreateRoomChargeDto {
  @ApiProperty({ enum: RoomChargeKind, example: RoomChargeKind.WATER }) @IsEnum(RoomChargeKind) kind!: RoomChargeKind;
  @ApiProperty({ example: 'Bottled water' }) @IsString() @MaxLength(200) description!: string;
  @ApiProperty({ example: 2, minimum: 1 }) @Type(() => Number) @IsInt() @Min(1) @Max(1000) quantity!: number;
  @ApiProperty({ example: 3.5, minimum: 0 }) @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000000) unitPrice!: number;
}
