import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { TableStatus } from 'prisma/generated/prisma/enums';

export class CreateTableDto {
  @ApiProperty({ example: 1, minimum: 1 }) @Type(() => Number) @IsInt() @Min(1)
  tableNumber!: number;
  @ApiProperty({ example: 4, minimum: 1 }) @Type(() => Number) @IsInt() @Min(1)
  capacity!: number;
  @ApiProperty({ enum: TableStatus, required: false, default: TableStatus.AVAILABLE }) @IsOptional() @IsEnum(TableStatus)
  status!: TableStatus;
}
