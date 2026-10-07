import { Controller, Get, Injectable, Module, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../packages/auth/guard';
import { Database } from '../../packages/database';
import { invariant } from '../../packages/contracts/errors';
import { loadConfig } from '../../packages/config';
@Injectable()
export class ContentService {
  constructor(private readonly db: Database) {}
  config() { return { minimumAndroidVersionCode: 2603, latestAndroidVersionCode: 2603,
    features: { booking: true, sandboxPayment: loadConfig().paymentProvider === 'sandbox', paymentProvider: loadConfig().paymentProvider,
      otpDelivery: loadConfig().otpDelivery, refunds: true, socialLogin: Boolean(process.env.FIREBASE_PROJECT_ID && process.env.GOOGLE_APPLICATION_CREDENTIALS),
      membership: true, paidMembership: true, academy: true, paidClasses: true, socialEvents: true,
      paidTickets: true, commerce: true, chat: true, chatE2E: true, mediaUpload: false,
      courtImageUpload: Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_BUCKET &&
        process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) },
    feedbackEmail: 'support@your-domain.com' }; }
  async document(slug: string) {
    const row = (await this.db.query('SELECT * FROM content.documents WHERE slug=$1', [slug])).rows[0];
    invariant(row, 'NOT_FOUND', 'Document not found', 404);
    return row;
  }
}
@Public() @ApiTags('content') @Controller('public')
export class ContentController {
  constructor(private readonly content: ContentService) {}
  @Get('config') config() { return this.content.config(); }
  @Get('content/:slug') document(@Param('slug') slug: string) { return this.content.document(slug); }
}
@Module({ controllers: [ContentController], providers: [ContentService] })
export class ContentModule {}
