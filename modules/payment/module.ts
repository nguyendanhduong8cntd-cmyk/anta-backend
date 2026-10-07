import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/module';
import { CommerceModule } from '../commerce/module';
import { PaymentController } from './controller';
import { PaymentService } from './service';
@Module({ imports: [BookingModule, CommerceModule], controllers: [PaymentController], providers: [PaymentService], exports: [PaymentService] })
export class PaymentModule {}
