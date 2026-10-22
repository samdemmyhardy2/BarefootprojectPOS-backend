import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsUUID, Min, Max, ValidateNested, IsEnum } from 'class-validator';
import { TableShape } from 'prisma/generated/prisma/enums';

export class TableLayoutItemDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID()
  id!: string;

  @ApiProperty({ minimum: 0, maximum: 11 }) @Type(() => Number) @IsInt() @Min(0) @Max(11)
  positionX!: number;

  @ApiProperty({ minimum: 0 }) @Type(() => Number) @IsInt() @Min(0)
  positionY!: number;

  @ApiProperty({ enum: TableShape }) @IsEnum(TableShape)
  shape!: TableShape;

  @ApiProperty({ minimum: 1, maximum: 12 }) @Type(() => Number) @IsInt() @Min(1) @Max(12)
  width!: number;

  @ApiProperty({ minimum: 1, maximum: 30 }) @Type(() => Number) @IsInt() @Min(1) @Max(30)
  height!: number;
}

export class UpdateTableLayoutDto {
  @ApiProperty({ type: [TableLayoutItemDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => TableLayoutItemDto)
  tables!: TableLayoutItemDto[];
}
