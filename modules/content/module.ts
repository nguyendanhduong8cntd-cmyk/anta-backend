import { Controller, Get, Injectable, Module, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../packages/auth/guard';
import { Database } from '../../packages/database';
import { invariant } from '../../packages/contracts/errors';
@Injectable()
export class ContentService {
  constructor(private readonly db: Database) {}
  config() { return { minimumAndroidVersionCode: 2603, latestAndroidVersionCode: 2603,
    features: { booking: true, sandboxPayment: true, socialLogin: false, membership: false, academy: false, chat: false, mediaUpload: false },
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
