import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

export class ImportMenuRowDto {
  @ApiProperty()
  @IsString() @MaxLength(80)
  category!: string;

  @ApiProperty()
  @IsString() @MaxLength(120)
  name!: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @ApiProperty()
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  price!: number;

  @ApiProperty({ enum: ['KITCHEN', 'BAR', 'NONE'] })
  @IsIn(['KITCHEN', 'BAR', 'NONE'])
  sendTo!: 'KITCHEN' | 'BAR' | 'NONE';
}

export class ImportMenuDto {
  @ApiProperty({ type: [ImportMenuRowDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => ImportMenuRowDto)
  rows!: ImportMenuRowDto[];
}
