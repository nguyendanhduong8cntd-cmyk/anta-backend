import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, RawBodyRequest, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthRequest, CurrentUser, Public } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { IntentDto, SandboxWebhookDto } from './dto';
import { PaymentService } from './service';
import { RefundService } from './refunds';
@ApiTags('payment') @Controller()
export class PaymentController {
  constructor(private readonly payments: PaymentService, private readonly refunds: RefundService) {}
  @ApiBearerAuth() @Post('payment-intents') @ApiHeader({ name: 'Idempotency-Key', required: true })
  create(@CurrentUser() user: Principal, @Body() dto: IntentDto, @Req() req: AuthRequest, @Headers('idempotency-key') key?: string) {
    return this.payments.create(user.userId, dto, key, req.ip);
  }
  @ApiBearerAuth() @Get('payment-intents/:id') get(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.payments.get(user.userId, id); }
  @ApiBearerAuth() @Get('users/me/refunds') myRefunds(@CurrentUser() user: Principal) { return this.refunds.mine(user.userId); }
  // Provider callbacks authenticate by signature, never by user session. Static routes must precede `:provider`.
  @Public() @Post('webhooks/payments/payos') @HttpCode(200)
  payos(@Body() body: Record<string, unknown>, @Req() req: RawBodyRequest<AuthRequest>) { return this.payments.payos(body, req.rawBody, req.requestId); }
  @Public() @Get('webhooks/payments/vnpay/ipn') @ApiExcludeEndpoint()
  async vnpay(@Query() query: Record<string, unknown>, @Req() req: AuthRequest, @Res() res: Response) {
    res.status(200).json(await this.payments.vnpay(query, req.requestId));
  }
  @Public() @Post('webhooks/payments/:provider')
  @ApiHeader({ name: 'X-Webhook-Timestamp', required: true }) @ApiHeader({ name: 'X-Webhook-Signature', required: true })
  webhook(@Param('provider') provider: string, @Body() dto: SandboxWebhookDto, @Req() req: RawBodyRequest<AuthRequest>,
    @Headers('x-webhook-timestamp') timestamp?: string, @Headers('x-webhook-signature') signature?: string) {
    return this.payments.webhook(provider, dto, req.rawBody, timestamp, signature, req.requestId);
  }
}
