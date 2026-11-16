import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { uploadPath } from '../../../common/upload-path';

export class UpdateRestaurantSettingsDto {
  @ApiProperty({ example: 'Table & Thyme', minLength: 1, maxLength: 80 })
  @IsString() @MinLength(1) @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ example: '/uploads/images/logo.png', nullable: true })
  @Transform(({ value }) => typeof value === 'string' ? uploadPath(value) : value)
  @IsOptional() @IsString() @MaxLength(500)
  logoUrl?: string | null;

  @ApiPropertyOptional({ example: 7, minimum: 0, maximum: 100, description: 'VAT percent added to every open dish and order.' })
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  vatPercent?: number;
}
