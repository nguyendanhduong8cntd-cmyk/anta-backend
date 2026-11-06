import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { BookingService } from '../booking/service';
import { BlockDto, OwnerBlockQuery, OwnerBookingQuery, OwnerScheduleQuery, RejectBookingDto } from './dto';
import { OwnerService } from './service';

/** Venue-owner portal API (`Chủ sân`). Every route checks branch ownership/staff membership from the server-verified
 * JWT; it never trusts a branchId/courtId the client sends as proof of access. */
@ApiTags('owner') @ApiBearerAuth() @Controller('owner')
export class OwnerController {
  constructor(private readonly owner: OwnerService, private readonly bookings: BookingService) {}

  @Get('branches') branches(@CurrentUser() user: Principal) { return this.owner.myBranches(user.userId); }

  @Get('courts/schedule') schedule(@CurrentUser() user: Principal, @Query() q: OwnerScheduleQuery) {
    return this.owner.schedule(user.userId, q);
  }

  @Get('bookings/stats') stats(@CurrentUser() user: Principal, @Query('branchId', new ParseUUIDPipe({ version: '4' })) branchId: string) {
    return this.owner.stats(user.userId, branchId);
  }
  @Get('bookings') list(@CurrentUser() user: Principal, @Query() q: OwnerBookingQuery) { return this.owner.bookings(user.userId, q); }
  @Get('bookings/:id') detail(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.owner.detail(user.userId, id);
  }
  @Post('bookings/:id/confirm') @HttpCode(200)
  confirm(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Req() req: AuthRequest) {
    return this.bookings.ownerConfirm(user.userId, id, req.requestId);
  }
  @Post('bookings/:id/reject') @HttpCode(200)
  reject(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RejectBookingDto, @Req() req: AuthRequest) {
    return this.bookings.ownerReject(user.userId, id, dto.reason.trim(), req.requestId);
  }

  @Get('courts/:courtId/blocks') listBlocks(@CurrentUser() user: Principal,
    @Param('courtId', new ParseUUIDPipe({ version: '4' })) courtId: string, @Query() q: OwnerBlockQuery) {
    return this.owner.listBlocks(user.userId, courtId, q.date);
  }
  @Post('courts/:courtId/blocks')
  createBlock(@CurrentUser() user: Principal, @Param('courtId', new ParseUUIDPipe({ version: '4' })) courtId: string,
    @Body() dto: BlockDto, @Req() req: AuthRequest) {
    return this.owner.createBlock(user.userId, courtId, dto, req.requestId);
  }
  @Delete('blocks/:id')
  releaseBlock(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Req() req: AuthRequest) {
    return this.owner.releaseBlock(user.userId, id, req.requestId);
  }
}
