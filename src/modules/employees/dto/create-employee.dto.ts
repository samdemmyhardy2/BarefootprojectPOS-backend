import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class CreateEmployeeDto {
  @ApiProperty({ example: 'Taylor Reed' }) @IsString() @IsNotEmpty() name!: string;
  @ApiProperty({ example: 'taylor@restaurant.com' }) @IsEmail() email!: string;
  @ApiProperty({ minLength: 8, writeOnly: true }) @IsString() @MinLength(8) password!: string;
  @ApiProperty({ example: 'Waiter', description: 'Job title within the restaurant.' }) @IsString() @IsNotEmpty() jobTitle!: string;
}
