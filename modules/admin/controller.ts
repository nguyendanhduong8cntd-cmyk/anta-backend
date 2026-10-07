import { Body, Controller, Delete, Get, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { RoleDto } from './dto';
import { AdminService } from './service';
@ApiTags('admin') @ApiBearerAuth() @Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}
  @Post('roles') grant(@CurrentUser() user: Principal, @Body() dto: RoleDto, @Req() req: AuthRequest) {
    return this.admin.grant(user.userId, dto, req.requestId);
  }
  @Delete('roles') revoke(@CurrentUser() user: Principal, @Body() dto: RoleDto, @Req() req: AuthRequest) {
    return this.admin.revoke(user.userId, dto, req.requestId);
  }
  @Get('audit-events') audit(@CurrentUser() user: Principal) { return this.admin.audit(user.userId); }
}
