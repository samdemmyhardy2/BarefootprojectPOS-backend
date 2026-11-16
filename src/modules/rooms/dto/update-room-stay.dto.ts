import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateRoomStayDto {
  @ApiPropertyOptional({ example: 'Jordan Lee' }) @IsOptional() @IsString() @MaxLength(120) primaryGuestName?: string;
  @ApiPropertyOptional({ example: '2026-10-30T02:48:00.000Z' }) @IsOptional() @IsDateString() checkedInAt?: string;
  @ApiPropertyOptional({ example: '2026-10-28T00:00:00.000Z' }) @IsOptional() @IsDateString() expectedCheckoutAt?: string | null;
  @ApiPropertyOptional({ example: 'Peanut allergy; vegetarian' }) @IsOptional() @IsString() @MaxLength(500) guestNotes?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() cashOnly?: boolean;
  @ApiPropertyOptional({ minimum: 0, example: 500, nullable: true }) @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) chargeLimit?: number | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) occupants?: string[];
}
