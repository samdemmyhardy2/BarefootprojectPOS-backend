import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';

export class BillSplitLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  orderItemId!: string;

  @ApiProperty()
  @Type(() => Number) @IsInt() @Min(0)
  unit!: number;
}

export class BillSplitEntryDto {
  @ApiProperty()
  @Type(() => Number) @IsInt() @Min(1)
  number!: number;

  @ApiProperty({ type: [BillSplitLineDto] })
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => BillSplitLineDto)
  lines!: BillSplitLineDto[];
}

export class SaveBillSplitDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Limit this bill split to one side of the table.' })
  @IsOptional() @IsUUID()
  splitId?: string;

  @ApiProperty({ type: [BillSplitEntryDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => BillSplitEntryDto)
  bills!: BillSplitEntryDto[];
}
