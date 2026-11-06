import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/module';
import { BookingModule } from '../booking/module';
import { OwnerController } from './controller';
import { OwnerService } from './service';
@Module({ imports: [CatalogModule, BookingModule], controllers: [OwnerController], providers: [OwnerService] })
export class OwnerModule {}
