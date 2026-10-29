import { Global, Module } from "@nestjs/common";
import { IdempotencyService } from "./idempotency.service";
import { PrismaService } from "./prisma.service";

@Global()
@Module({
  imports: [],
  providers: [PrismaService, IdempotencyService],
  exports: [PrismaService, IdempotencyService]
})
export class PrismaModule { }
