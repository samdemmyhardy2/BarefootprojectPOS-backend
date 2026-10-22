import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { TableShape, TableStatus } from 'prisma/generated/prisma/enums';

export class CreateTableDto {
  @ApiProperty({ example: 1, minimum: 1 }) @Type(() => Number) @IsInt() @Min(1)
  tableNumber!: number;
  @ApiProperty({ example: 4, minimum: 1 }) @Type(() => Number) @IsInt() @Min(1)
  capacity!: number;
  @ApiProperty({ enum: TableStatus, required: false, default: TableStatus.AVAILABLE }) @IsOptional() @IsEnum(TableStatus)
  status!: TableStatus;

  @ApiProperty({ enum: TableShape, required: false, default: TableShape.RECTANGLE }) @IsOptional() @IsEnum(TableShape)
  shape?: TableShape;

  @ApiProperty({ minimum: 0, maximum: 7, required: false, description: 'Grid column in the floor layout (0–7).' }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(7)
  positionX?: number;

  @ApiProperty({ minimum: 0, required: false, description: 'Row slot in the floor layout.' }) @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  positionY?: number;
}
