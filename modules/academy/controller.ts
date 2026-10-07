import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser, Public } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { CreateCenterDto, CreateClassDto, CreateCourseDto, AttendDto } from './dto';
import { AcademyService } from './service';
import { CenterFilterDto, CourseFilterDto, SessionTimeDto } from '../../packages/contracts/query';
@ApiTags('academy') @Controller()
export class AcademyController {
  constructor(private readonly academy: AcademyService) {}
  @Public() @Get('academy/centers') centers() { return this.academy.centers(); }
  @Public() @Get('academy/centers/:id') center(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.academy.center(id); }
  @Public() @Get('academy/coaches') coaches(@Query() q: CenterFilterDto) { return this.academy.coaches(q.centerId); }
  @Public() @Get('academy/courses') courses(@Query() q: CenterFilterDto) { return this.academy.courses(q.centerId); }
  @Public() @Get('academy/courses/:id') course(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.academy.course(id); }
  @Public() @Get('academy/classes') classes(@Query() q: CourseFilterDto) { return this.academy.classes(q.courseId); }
  @Public() @Get('academy/classes/:id') class(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.academy.class(id); }
  @ApiBearerAuth() @Post('academy/centers') createCenter(@CurrentUser() u: Principal, @Body() dto: CreateCenterDto, @Req() req: AuthRequest) { return this.academy.createCenter(u.userId, dto, req.requestId); }
  @ApiBearerAuth() @Post('academy/courses') createCourse(@CurrentUser() u: Principal, @Body() dto: CreateCourseDto, @Req() req: AuthRequest) { return this.academy.createCourse(u.userId, dto, req.requestId); }
  @ApiBearerAuth() @Post('academy/classes') createClass(@CurrentUser() u: Principal, @Body() dto: CreateClassDto, @Req() req: AuthRequest) { return this.academy.createClass(u.userId, dto, req.requestId); }
  @ApiBearerAuth() @Post('academy/classes/:id/enrollments') @ApiHeader({ name: 'Idempotency-Key', required: true })
  enroll(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthRequest) { return this.academy.enroll(u.userId, id, key, req.requestId); }
  @ApiBearerAuth() @Delete('academy/enrollments/:id') cancel(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.academy.cancel(u.userId, id); }
  @ApiBearerAuth() @Get('users/me/class-sessions') sessions(@CurrentUser() u: Principal) { return this.academy.sessions(u.userId); }
  @ApiBearerAuth() @Post('academy/classes/:id/sessions') addSession(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SessionTimeDto, @Req() req: AuthRequest) { return this.academy.addSession(u.userId, id, dto.startsAt, dto.endsAt, req.requestId); }
  @ApiBearerAuth() @Post('academy/sessions/:id/attendance') attendance(@CurrentUser() u: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: AttendDto, @Req() req: AuthRequest) {
    return this.academy.markAttendance(u.userId, id, dto.enrollmentId, dto.present, req.requestId);
  }
}
