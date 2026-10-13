import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNumber, IsOptional, Max, MaxLength, Min } from 'class-validator';
import { RoomSize } from 'prisma/generated/prisma/enums';

export class CreateRoomDto {
  @ApiProperty({ example: 201, minimum: 1 }) @Type(() => Number) @IsInt() @Min(1) roomNumber!: number;
  @ApiProperty({ enum: RoomSize, example: RoomSize.NORMAL }) @IsEnum(RoomSize) size!: RoomSize;
  @ApiPropertyOptional({ example: 25, minimum: 0, description: 'One-time room usage fee for this stay.' }) @Type(() => Number) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000000) usageFee?: number;
}
