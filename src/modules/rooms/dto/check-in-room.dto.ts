import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CheckInRoomDto {
  @ApiProperty({ example: 'Jordan Lee' }) @IsString() @IsNotEmpty() @MaxLength(120) primaryGuestName!: string;
  @ApiPropertyOptional({ type: [String], example: ['Jordan Lee', 'Taylor Lee'] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) occupants?: string[];
  @ApiPropertyOptional({ example: '2026-10-28T00:00:00.000Z' }) @IsOptional() @IsDateString() expectedCheckoutAt?: string;
  @ApiPropertyOptional({ example: 'Peanut allergy; vegetarian' }) @IsOptional() @IsString() @MaxLength(500) guestNotes?: string;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() cashOnly?: boolean;
  @ApiPropertyOptional({ minimum: 0, example: 500 }) @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) chargeLimit?: number;
}
