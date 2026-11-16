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
import { RestaurantSettingsModule } from './modules/restaurant-settings/restaurant-settings.module';
import { TechnicalModule } from './modules/technical/technical.module';
import { PrintingModule } from './modules/printing/printing.module';
import { BackupModule } from './modules/backup/backup.module';
import { SyncModule } from './modules/sync/sync.module';

@Module({
  imports: [PrismaModule, AuthModule, OrdersModule, MenuModule, TablesModule, EmployeesModule, RoomsModule, TasksModule, AnalyticsModule, RestaurantSettingsModule, TechnicalModule, PrintingModule, BackupModule, SyncModule],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule { }
