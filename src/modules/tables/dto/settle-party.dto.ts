import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { OrderPaymentMethod } from 'prisma/generated/prisma/enums';

export class SettlePartyDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID(undefined, { each: true })
  orderIds!: string[];

  @ApiProperty({ enum: [OrderPaymentMethod.CASH, OrderPaymentMethod.CARD, OrderPaymentMethod.PROMPTPAY, OrderPaymentMethod.ROOM_CHECKOUT] })
  @IsEnum(OrderPaymentMethod)
  paymentMethod!: OrderPaymentMethod;

  @ApiPropertyOptional({ description: 'Required for a room folio charge.' })
  @IsOptional() @IsString() @MaxLength(120)
  signedByName?: string;

  @ApiPropertyOptional({ description: 'Data URL or encoded signature image, required for a room folio charge.' })
  @IsOptional() @IsString() @MaxLength(500000)
  signatureData?: string;
}
