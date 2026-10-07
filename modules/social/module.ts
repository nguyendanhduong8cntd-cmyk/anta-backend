import { Module } from '@nestjs/common';
import { MembershipModule } from '../membership/module';
import { SocialController } from './controller';
import { SocialService } from './service';
@Module({ imports: [MembershipModule], controllers: [SocialController], providers: [SocialService] })
export class SocialModule {}
