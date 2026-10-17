import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, IsUrl, IsUUID, MaxLength, Min, ValidateIf } from 'class-validator';
import { MatchesFoodLabelLanguages } from './food-label-languages.validator';

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

  @ApiPropertyOptional({ type: [String], example: ['Milk', 'Wheat', 'Peanuts'], description: 'Individual known allergens; shown to staff and guests.' })
  @Transform(({ value }) => typeof value === 'string' ? value.split(',').map((label: string) => label.trim()).filter(Boolean) : value)
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(80, { each: true })
  allergens?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Burmese translations matching allergens by array index.' })
  @ValidateIf((dto: CreateMenuItemDto) => dto.allergens !== undefined || dto.allergensMy !== undefined)
  @MatchesFoodLabelLanguages('allergens')
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(80, { each: true })
  allergensMy?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Thai translations matching allergens by array index.' })
  @ValidateIf((dto: CreateMenuItemDto) => dto.allergens !== undefined || dto.allergensTh !== undefined)
  @MatchesFoodLabelLanguages('allergens')
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(80, { each: true })
  allergensTh?: string[];

  @ApiPropertyOptional({ type: [String], example: ['Vegetarian', 'Contains dairy'], description: 'Individual dietary labels or preparation notes.' })
  @Transform(({ value }) => typeof value === 'string' ? value.split(',').map((label: string) => label.trim()).filter(Boolean) : value)
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(80, { each: true })
  dietaryInfo?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Burmese translations matching dietary labels by array index.' })
  @ValidateIf((dto: CreateMenuItemDto) => dto.dietaryInfo !== undefined || dto.dietaryInfoMy !== undefined)
  @MatchesFoodLabelLanguages('dietaryInfo')
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(80, { each: true })
  dietaryInfoMy?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Thai translations matching dietary labels by array index.' })
  @ValidateIf((dto: CreateMenuItemDto) => dto.dietaryInfo !== undefined || dto.dietaryInfoTh !== undefined)
  @MatchesFoodLabelLanguages('dietaryInfo')
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(80, { each: true })
  dietaryInfoTh?: string[];

  @ApiPropertyOptional({ type: [String], example: ['Add tomato', 'Extra cheese', 'Avocado'] })
  @Transform(({ value }) => typeof value === 'string' ? value.split(',').map((label: string) => label.trim()).filter(Boolean) : value)
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(80, { each: true })
  availableExtras?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Burmese translations matching extras by array index.' })
  @ValidateIf((dto: CreateMenuItemDto) => dto.availableExtras !== undefined || dto.availableExtrasMy !== undefined)
  @MatchesFoodLabelLanguages('availableExtras')
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(80, { each: true })
  availableExtrasMy?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Thai translations matching extras by array index.' })
  @ValidateIf((dto: CreateMenuItemDto) => dto.availableExtras !== undefined || dto.availableExtrasTh !== undefined)
  @MatchesFoodLabelLanguages('availableExtras')
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(80, { each: true })
  availableExtrasTh?: string[];

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId!: string;
}
