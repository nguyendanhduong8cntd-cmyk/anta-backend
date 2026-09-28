import { Module } from '@nestjs/common';
import { CatalogService } from './service';
import { CatalogController } from './controller';
@Module({ controllers: [CatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
