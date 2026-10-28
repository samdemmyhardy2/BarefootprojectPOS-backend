import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { MenuItemsController } from './menu-items.controller';
import { MenuItemsService } from './menu-items.service';
import { MediaController } from './media.controller';
import { ModifierGroupsController } from './modifier-groups.controller';
import { ModifierGroupsService } from './modifier-groups.service';

@Module({ controllers: [CategoriesController, MenuItemsController, MediaController, ModifierGroupsController], providers: [CategoriesService, MenuItemsService, ModifierGroupsService] })
export class MenuModule {}
