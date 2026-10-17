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
import { TasksModule } from './modules/tasks/tasks.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';

@Module({
  imports: [PrismaModule, AuthModule, OrdersModule, MenuModule, TablesModule, EmployeesModule, RoomsModule, TasksModule, AnalyticsModule],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule { }
