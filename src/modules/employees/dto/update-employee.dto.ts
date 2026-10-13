import { ApiPropertyOptional, PartialType, OmitType } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { CreateEmployeeDto } from './create-employee.dto';

export class UpdateEmployeeDto extends PartialType(OmitType(CreateEmployeeDto, ['password'] as const)) {
  @ApiPropertyOptional({ minLength: 8, writeOnly: true }) @IsOptional() @IsString() @MinLength(8)
  password?: string;
}
