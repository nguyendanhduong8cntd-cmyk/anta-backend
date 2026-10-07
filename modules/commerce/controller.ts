import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { CommerceService } from './service';
import { CreateOrderDto, CreateVoucherDto, ValidateVoucherDto } from './dto';
@ApiTags('commerce') @ApiBearerAuth() @Controller()
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}
  @Post('vouchers') voucher(@CurrentUser() u: Principal, @Body() dto: CreateVoucherDto, @Req() req: AuthRequest) { return this.commerce.createVoucher(u.userId, dto, req.requestId); }
  @Post('vouchers/validate') validate(@Body() dto: ValidateVoucherDto) { return this.commerce.validateVoucher(dto); }
  @Post('orders') @ApiHeader({ name: 'Idempotency-Key', required: true })
  create(@CurrentUser() u: Principal, @Body() dto: CreateOrderDto, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthRequest) {
    return this.commerce.createOrder(u.userId, dto, key, req.requestId);
  }
  @Get('users/me/orders') list(@CurrentUser() u: Principal) { return this.commerce.list(u.userId); }
  @Get('orders/:id') get(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.commerce.get(u.userId, id); }
  @Post('orders/:id/cancel') @ApiHeader({ name: 'Idempotency-Key', required: true })
  cancel(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('idempotency-key') key: string | undefined, @Req() req: AuthRequest) { return this.commerce.cancel(u.userId, id, key, req.requestId); }
}
