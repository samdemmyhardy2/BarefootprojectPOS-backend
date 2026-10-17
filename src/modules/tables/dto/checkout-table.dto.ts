import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { OrderPaymentMethod } from 'prisma/generated/prisma/enums';

export class CheckoutTableDto {
  @ApiProperty({ enum: OrderPaymentMethod, description: 'Cash payment or charge the table bill to an active room folio.' })
  @IsEnum(OrderPaymentMethod)
  paymentMethod!: OrderPaymentMethod;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required when paymentMethod is ROOM_CHECKOUT.' })
  @IsOptional() @IsUUID()
  roomStayId?: string;
}
