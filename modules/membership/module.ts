import { Module } from '@nestjs/common';
import { MembershipController } from './controller';
import { MembershipService } from './service';
@Module({ controllers: [MembershipController], providers: [MembershipService], exports: [MembershipService] })
export class MembershipModule {}
