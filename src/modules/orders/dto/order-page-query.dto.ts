import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { OrderStatus } from 'prisma/generated/prisma/enums';

export class OrderPageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  limit?: number;

  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;

  @IsOptional() @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional() @IsIn(['UNPAID', 'CASH', 'CARD', 'PROMPTPAY', 'ROOM', 'COUNTER', 'COMMISSION'])
  payment?: 'UNPAID' | 'CASH' | 'CARD' | 'PROMPTPAY' | 'ROOM' | 'COUNTER' | 'COMMISSION';

  @IsOptional() @IsIn(['TABLE', 'ROOM', 'WALKIN'])
  place?: 'TABLE' | 'ROOM' | 'WALKIN';
}
