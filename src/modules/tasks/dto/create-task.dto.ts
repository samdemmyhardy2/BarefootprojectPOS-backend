import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsDateString, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateTaskDto {
  @ApiProperty({ example: 'Restock the beverage station' }) @IsString() @IsNotEmpty() @MaxLength(160) title!: string;
  @ApiPropertyOptional({ example: 'Check all refrigerators before dinner service.' }) @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiProperty({ type: [String], format: 'uuid', minItems: 1 }) @IsArray() @ArrayMinSize(1) @IsUUID('4', { each: true }) assignedToIds!: string[];
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() dueAt?: string;
}
