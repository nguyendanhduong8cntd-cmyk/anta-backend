import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/module';
import { BookingController } from './controller';
import { BookingService } from './service';
@Module({ imports: [CatalogModule], controllers: [BookingController], providers: [BookingService], exports: [BookingService] })
export class BookingModule {}
