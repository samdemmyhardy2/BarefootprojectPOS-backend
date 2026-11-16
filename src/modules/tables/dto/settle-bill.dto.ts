import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { OrderPaymentMethod } from 'prisma/generated/prisma/enums';

export class SettleBillDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  clientRequestId?: string;

  @ApiProperty({ enum: [OrderPaymentMethod.CASH, OrderPaymentMethod.CARD, OrderPaymentMethod.PROMPTPAY, OrderPaymentMethod.ROOM_CHECKOUT] })
  @IsEnum(OrderPaymentMethod)
  paymentMethod!: OrderPaymentMethod;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  roomStayId?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(120)
  signedByName?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500000)
  signatureData?: string;
}
