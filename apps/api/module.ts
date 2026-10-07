import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthModule, Public } from '../../packages/auth/guard';
import { Database, DatabaseModule } from '../../packages/database';
import { RedisModule, RedisService } from '../../packages/redis';
import { IdempotencyModule } from '../../packages/idempotency';
import { IdentityModule } from '../../modules/identity/module';
import { CatalogModule } from '../../modules/catalog/module';
import { BookingModule } from '../../modules/booking/module';
import { PaymentModule } from '../../modules/payment/module';
import { NotificationModule } from '../../modules/notification/module';
import { ContentModule } from '../../modules/content/module';
import { AccessModule } from '../../packages/access';
import { MembershipModule } from '../../modules/membership/module';
import { AcademyModule } from '../../modules/academy/module';
import { SocialModule } from '../../modules/social/module';
import { CommerceModule } from '../../modules/commerce/module';
import { ChatModule } from '../../modules/chat/module';
import { AdminModule } from '../../modules/admin/module';
import { MediaModule } from '../../modules/media/module';
@Public() @ApiTags('health') @Controller('health')
class HealthController {
  constructor(private readonly db: Database, private readonly redis: RedisService) {}
  @Get('live') live() { return { status: 'ok' }; }
  @Get('ready') async ready() {
    try {
      await this.db.query('SELECT id FROM identity.users LIMIT 0');
      await this.redis.client.ping();
      return { status: 'ready', database: 'ok', redis: 'ok' };
    } catch { throw new ServiceUnavailableException(); }
  }
}
@Module({
  imports: [DatabaseModule, RedisModule, AuthModule, IdempotencyModule, AccessModule, IdentityModule, CatalogModule,
    BookingModule, PaymentModule, NotificationModule, ContentModule, MembershipModule, AcademyModule, SocialModule, CommerceModule, ChatModule, AdminModule, MediaModule],
  controllers: [HealthController], providers: [{ provide: APP_GUARD, useClass: AuthGuard }]
})
export class ApiModule {}
