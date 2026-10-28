import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';
import { ModifierMadeAt, ModifierSelectionType } from 'prisma/generated/prisma/enums';

export class ModifierOptionInputDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) nameMy?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) nameTh?: string;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) priceAdjustment?: number;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() defaultSelected?: boolean;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() opensGroupId?: string | null;
}

export class CreateModifierGroupDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) nameMy?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) nameTh?: string;
  @ApiPropertyOptional({ default: 'General' }) @IsOptional() @IsString() @MaxLength(80) category?: string;
  @ApiPropertyOptional({ enum: ['Utensils', 'Salad', 'Coffee', 'ChefHat', 'Flame', 'CircleDot', 'Sparkles', 'Cookie'], default: 'Utensils' }) @IsOptional() @IsIn(['Utensils', 'Salad', 'Coffee', 'ChefHat', 'Flame', 'CircleDot', 'Sparkles', 'Cookie']) icon?: string;
  @ApiPropertyOptional({ enum: ['RADIO', 'CHECKBOX', 'SLIDER', 'QUANTITY', 'TEXT'], default: 'CHECKBOX' }) @IsOptional() @IsIn(['RADIO', 'CHECKBOX', 'SLIDER', 'QUANTITY', 'TEXT']) appearance?: string;
  @ApiPropertyOptional({ enum: ModifierMadeAt, default: ModifierMadeAt.SAME_AS_DISH }) @IsOptional() @IsEnum(ModifierMadeAt) madeAt?: ModifierMadeAt;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() required?: boolean;
  @ApiPropertyOptional({ enum: ModifierSelectionType }) @IsOptional() @IsEnum(ModifierSelectionType) selectionType?: ModifierSelectionType;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsInt() @Min(0) minPicks?: number;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) maxPicks?: number;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsInt() @Min(0) includedPicks?: number;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) extraPickPrice?: number;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() allowDuplicates?: boolean;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsInt() @Min(0) position?: number;
  @ApiProperty({ type: [ModifierOptionInputDto] }) @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ModifierOptionInputDto) options!: ModifierOptionInputDto[];
}

export class UpdateModifierGroupDto extends PartialType(CreateModifierGroupDto) {}

export class ModifierGroupQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) category?: string;
  @ApiPropertyOptional({ enum: ['Utensils', 'Salad', 'Coffee', 'ChefHat', 'Flame', 'CircleDot', 'Sparkles', 'Cookie'], default: 'Utensils' }) @IsOptional() @IsIn(['Utensils', 'Salad', 'Coffee', 'ChefHat', 'Flame', 'CircleDot', 'Sparkles', 'Cookie']) icon?: string;
  @ApiPropertyOptional({ enum: ['RADIO', 'CHECKBOX', 'SLIDER', 'QUANTITY', 'TEXT'], default: 'CHECKBOX' }) @IsOptional() @IsIn(['RADIO', 'CHECKBOX', 'SLIDER', 'QUANTITY', 'TEXT']) appearance?: string;
  @ApiPropertyOptional({ enum: ModifierMadeAt, default: ModifierMadeAt.SAME_AS_DISH }) @IsOptional() @IsEnum(ModifierMadeAt) madeAt?: ModifierMadeAt;
}

export class ModifierGroupIdsDto {
  @ApiProperty({ type: [String], format: 'uuid' }) @IsArray() @ArrayMaxSize(50) @IsUUID(undefined, { each: true }) groupIds!: string[];
}
