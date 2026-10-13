import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { OrdersModule } from './modules/orders/orders.module';
import { PrismaModule } from './utils/prisma/prisma.module';
import { MenuModule } from './modules/menu/menu.module';
import { TablesModule } from './modules/tables/tables.module';
import { AuthModule } from './modules/auth/auth.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { HealthController } from './health.controller';
import { RoomsModule } from './modules/rooms/rooms.module';

@Module({
  imports: [PrismaModule, AuthModule, OrdersModule, MenuModule, TablesModule, EmployeesModule, RoomsModule],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule { }
