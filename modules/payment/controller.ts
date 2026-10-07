import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser, Public } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { IntentDto, SandboxWebhookDto } from './dto';
import { PaymentService } from './service';
@ApiTags('payment') @Controller()
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}
  @ApiBearerAuth() @Post('payment-intents') @ApiHeader({ name: 'Idempotency-Key', required: true })
  create(@CurrentUser() user: Principal, @Body() dto: IntentDto, @Headers('idempotency-key') key?: string) { return this.payments.create(user.userId, dto, key); }
  @ApiBearerAuth() @Get('payment-intents/:id') get(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.payments.get(user.userId, id); }
  @Public() @Post('webhooks/payments/:provider')
  @ApiHeader({ name: 'X-Webhook-Timestamp', required: true }) @ApiHeader({ name: 'X-Webhook-Signature', required: true })
  webhook(@Param('provider') provider: string, @Body() dto: SandboxWebhookDto, @Req() req: RawBodyRequest<AuthRequest>,
    @Headers('x-webhook-timestamp') timestamp?: string, @Headers('x-webhook-signature') signature?: string) {
    return this.payments.webhook(provider, dto, req.rawBody, timestamp, signature, req.requestId);
  }
}
