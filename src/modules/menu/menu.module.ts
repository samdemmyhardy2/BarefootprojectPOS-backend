import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { MenuItemsController } from './menu-items.controller';
import { MenuItemsService } from './menu-items.service';
import { MediaController } from './media.controller';

@Module({ controllers: [CategoriesController, MenuItemsController, MediaController], providers: [CategoriesService, MenuItemsService] })
export class MenuModule {}
