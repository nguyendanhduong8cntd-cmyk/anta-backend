import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, AuthRequest } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { CreatePlanDto, EnrollPlanDto } from './dto';
import { MembershipService } from './service';
import { BranchFilterDto } from '../../packages/contracts/query';
@ApiTags('membership') @Controller()
export class MembershipController {
  constructor(private readonly memberships: MembershipService) {}
  @Public() @Get('public/membership-plans') plans(@Query() query: BranchFilterDto) { return this.memberships.plans(query.branchId); }
  @Public() @Get('public/membership-plans/:id') plan(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.memberships.plan(id); }
  @ApiBearerAuth() @Post('membership-plans') createPlan(@CurrentUser() user: Principal, @Body() dto: CreatePlanDto, @Req() req: AuthRequest) {
    return this.memberships.createPlan(user.userId, dto, req.requestId);
  }
  @ApiBearerAuth() @Post('membership-contracts') @ApiHeader({ name: 'Idempotency-Key', required: true })
  enroll(@CurrentUser() user: Principal, @Body() dto: EnrollPlanDto, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthRequest) {
    return this.memberships.enroll(user.userId, dto.planId, key, req.requestId);
  }
  @ApiBearerAuth() @Get('users/me/membership-contracts') contracts(@CurrentUser() user: Principal) { return this.memberships.contracts(user.userId); }
  @ApiBearerAuth() @Get('membership-contracts/:id') get(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.memberships.get(user.userId, id); }
  @ApiBearerAuth() @Get('membership-contracts/:id/usages') usages(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.memberships.usages(user.userId, id); }
}
