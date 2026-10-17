import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { RoomSize } from 'prisma/generated/prisma/enums';

export class CreateRoomDto {
  @ApiProperty({ example: 201, minimum: 1 }) @Type(() => Number) @IsInt() @Min(1) roomNumber!: number;
  @ApiProperty({ enum: RoomSize, example: RoomSize.NORMAL }) @IsEnum(RoomSize) size!: RoomSize;
  @ApiProperty({ example: 25, minimum: 0, description: 'One-time room usage fee for this stay.' }) @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000000) usageFee!: number;
  @ApiPropertyOptional({ type: [String], example: ['Air conditioning', 'Wi-Fi', 'Family-size bed'] }) @IsOptional() @IsArray() @IsString({ each: true }) facilities?: string[];
}
