import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser, Public } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { AvailabilityQuery, BookingDto, BookingQuery, BookingServiceDto, ParticipantDto, RecurringBookingDto, ReviewDto, SlotDto } from './dto';
import { BookingService } from './service';
const keyHeader = { name: 'Idempotency-Key', required: true, description: '8-128 alphanumeric, underscore, dot or hyphen characters' };
@ApiTags('booking') @Controller()
export class BookingController {
  constructor(private readonly booking: BookingService) {}
  @Public() @Get('public/branches/:id/availability') availability(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Query() q: AvailabilityQuery) { return this.booking.availability(id, q); }
  @ApiBearerAuth() @Post('quotes') quote(@Body() dto: SlotDto) { return this.booking.quote(dto); }
  @ApiBearerAuth() @Post('booking-holds') @ApiHeader(keyHeader)
  hold(@CurrentUser() user: Principal, @Body() dto: SlotDto, @Headers('idempotency-key') key?: string) { return this.booking.hold(user.userId, dto, key); }
  @ApiBearerAuth() @Delete('booking-holds/:id') release(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.booking.release(user.userId, id); }
  @ApiBearerAuth() @Post('bookings') @ApiHeader(keyHeader)
  create(@CurrentUser() user: Principal, @Body() dto: BookingDto, @Req() req: AuthRequest, @Headers('idempotency-key') key?: string) { return this.booking.create(user.userId, dto.holdId, key, req.requestId); }
  @ApiBearerAuth() @Post('booking-series') @ApiHeader(keyHeader)
  recurring(@CurrentUser() user: Principal, @Body() dto: RecurringBookingDto, @Req() req: AuthRequest,
    @Headers('idempotency-key') key?: string) { return this.booking.createSeries(user.userId, dto, key, req.requestId); }
  @ApiBearerAuth() @Get('booking-series/:id') series(@CurrentUser() user: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.booking.series(user.userId, id); }
  @ApiBearerAuth() @Get('users/me/bookings') list(@CurrentUser() user: Principal, @Query() q: BookingQuery) { return this.booking.list(user.userId, q); }
  @ApiBearerAuth() @Get('bookings/:id') get(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.booking.get(user.userId, id); }
  @ApiBearerAuth() @Post('bookings/:id/cancel') @ApiHeader(keyHeader)
  cancel(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Req() req: AuthRequest, @Headers('idempotency-key') key?: string) { return this.booking.cancel(user.userId, id, key, req.requestId); }
  @ApiBearerAuth() @Post('bookings/:id/participants') invite(@CurrentUser() user: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: ParticipantDto, @Req() req: AuthRequest) {
    return this.booking.inviteParticipant(user.userId, id, dto.userId, req.requestId);
  }
  @ApiBearerAuth() @Get('bookings/:id/participants') participants(@CurrentUser() user: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.booking.participants(user.userId, id); }
  @ApiBearerAuth() @Post('bookings/:id/participants/accept') accept(@CurrentUser() user: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.booking.acceptParticipant(user.userId, id); }
  @ApiBearerAuth() @Delete('bookings/:id/participants/:participantId') removeParticipant(@CurrentUser() user: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('participantId', new ParseUUIDPipe({ version: '4' })) participantId: string) {
    return this.booking.removeParticipant(user.userId, id, participantId);
  }
  @ApiBearerAuth() @Post('bookings/:id/services') @ApiHeader(keyHeader)
  addService(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: BookingServiceDto, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthRequest) {
    return this.booking.addService(user.userId, id, dto, key, req.requestId);
  }
  @ApiBearerAuth() @Post('bookings/:id/reviews') review(@CurrentUser() user: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: ReviewDto, @Req() req: AuthRequest) {
    return this.booking.review(user.userId, id, dto, req.requestId);
  }
  @Public() @Get('public/branches/:id/reviews') reviews(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.booking.reviews(id);
  }
}
