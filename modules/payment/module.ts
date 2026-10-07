import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/module';
import { CommerceModule } from '../commerce/module';
import { MembershipModule } from '../membership/module';
import { AcademyModule } from '../academy/module';
import { SocialModule } from '../social/module';
import { PaymentController } from './controller';
import { PaymentService } from './service';
@Module({ imports: [BookingModule, CommerceModule, MembershipModule, AcademyModule, SocialModule], controllers: [PaymentController], providers: [PaymentService], exports: [PaymentService] })
export class PaymentModule {}
