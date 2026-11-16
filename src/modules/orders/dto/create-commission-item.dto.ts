import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateCommissionItemDto {
  @ApiProperty({ example: 'Speed boat' }) @IsString() @MaxLength(80) name!: string;
  @ApiProperty({ example: 350, description: 'Amount the guest pays.' }) @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000000) price!: number;
  @ApiProperty({ example: 50, description: 'Amount shown on the daily commission report.' }) @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000000) commission!: number;
}
