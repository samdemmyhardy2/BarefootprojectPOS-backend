import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUrl, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateMenuItemDto {
  @ApiProperty({ example: 'Crispy Calamari' })
  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Lightly fried calamari with lemon aioli.' })
  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @ApiProperty({ example: 12.5, minimum: 0.01 })
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
  price!: number;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/calamari.jpg' })
  // Local development uploads use http://localhost URLs, which are valid
  // image URLs even though they do not have a public DNS suffix.
  @IsOptional() @IsUrl({ require_protocol: true, require_tld: false })
  imageUrl?: string;

  @ApiPropertyOptional({ example: 'Milk, wheat, peanuts', description: 'Known allergens; shown to staff and customers.' })
  @IsOptional() @IsString() @MaxLength(500)
  allergens?: string;

  @ApiPropertyOptional({ example: 'Vegetarian, contains dairy', description: 'Dietary labels or preparation notes.' })
  @IsOptional() @IsString() @MaxLength(500)
  dietaryInfo?: string;

  @ApiPropertyOptional({ example: 'Add tomato, Extra cheese, Avocado' })
  @IsOptional() @IsString() @MaxLength(500)
  availableExtras?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId!: string;
}
