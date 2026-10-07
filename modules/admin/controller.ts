import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { RefundService } from '../payment/refunds';
import { AdminListQuery, ResolveRefundDto, RoleDto } from './dto';
import { AdminService } from './service';
@ApiTags('admin') @ApiBearerAuth() @Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService, private readonly refunds: RefundService) {}
  @Post('roles') grant(@CurrentUser() user: Principal, @Body() dto: RoleDto, @Req() req: AuthRequest) {
    return this.admin.grant(user.userId, dto, req.requestId);
  }
  @Delete('roles') revoke(@CurrentUser() user: Principal, @Body() dto: RoleDto, @Req() req: AuthRequest) {
    return this.admin.revoke(user.userId, dto, req.requestId);
  }
  @Get('audit-events') audit(@CurrentUser() user: Principal) { return this.admin.audit(user.userId); }
  @Get('stats') stats(@CurrentUser() user: Principal) { return this.admin.stats(user.userId); }
  @Get('users') users(@CurrentUser() user: Principal, @Query() q: AdminListQuery) { return this.admin.users(user.userId, q); }
  @Get('branches') branches(@CurrentUser() user: Principal) { return this.admin.branches(user.userId); }
  @Get('bookings') bookings(@CurrentUser() user: Principal, @Query() q: AdminListQuery) { return this.admin.bookings(user.userId, q); }
  @Get('payment-intents') intents(@CurrentUser() user: Principal, @Query() q: AdminListQuery) { return this.admin.intents(user.userId, q); }
  @Get('deletion-requests') deletions(@CurrentUser() user: Principal) { return this.admin.deletions(user.userId); }
  @Get('refunds') listRefunds(@CurrentUser() user: Principal, @Query() q: AdminListQuery) { return this.refunds.list(user.userId, q.status); }
  @Post('refunds/:id/resolve') @HttpCode(200) resolveRefund(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ResolveRefundDto, @Req() req: AuthRequest) { return this.refunds.resolve(user.userId, id, dto.outcome, dto.providerRef, req.requestId); }
  @Post('payment-intents/:id/refund') @HttpCode(200) refundLate(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: AuthRequest) { return this.refunds.refundLatePayment(user.userId, id, req.requestId); }
}
