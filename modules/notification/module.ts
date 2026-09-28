import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { Database } from '../../packages/database';
import { CurrentUser } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { invariant } from '../../packages/contracts/errors';
import { BookingQuery } from '../booking/dto';
export class PreferenceDto {
  @ApiProperty() @IsBoolean() pushEnabled!: boolean;
}
@Injectable()
export class NotificationService {
  constructor(private readonly db: Database) {}
  async list(userId: string, q: BookingQuery) {
    const page = q.page || 1, pageSize = q.pageSize || 20;
    const rows = (await this.db.query('SELECT *,count(*) OVER()::int AS total FROM notification.notifications WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3', [userId, pageSize, (page - 1) * pageSize])).rows;
    return { items: rows.map(({ total, ...row }) => row), page, pageSize, total: rows[0]?.total || 0 };
  }
  async read(userId: string, id: string) {
    const row = (await this.db.query('UPDATE notification.notifications SET read_at=coalesce(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING *', [id, userId])).rows[0];
    invariant(row, 'NOT_FOUND', 'Notification not found', 404);
    return row;
  }
  async preference(userId: string, pushEnabled?: boolean) {
    if (pushEnabled !== undefined) await this.db.query('INSERT INTO notification.preferences(user_id,push_enabled) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET push_enabled=excluded.push_enabled,updated_at=now()', [userId, pushEnabled]);
    return { pushEnabled: (await this.db.query('SELECT push_enabled FROM notification.preferences WHERE user_id=$1', [userId])).rows[0]?.push_enabled ?? true };
  }
}
@ApiTags('notification') @ApiBearerAuth() @Controller()
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}
  @Get('notifications') list(@CurrentUser() u: Principal, @Query() q: BookingQuery) { return this.notifications.list(u.userId, q); }
  @Post('notifications/:id/read') read(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.notifications.read(u.userId, id); }
  @Get('notification-preferences') preference(@CurrentUser() u: Principal) { return this.notifications.preference(u.userId); }
  @Patch('notification-preferences') update(@CurrentUser() u: Principal, @Body() dto: PreferenceDto) { return this.notifications.preference(u.userId, dto.pushEnabled); }
}
@Module({ controllers: [NotificationController], providers: [NotificationService], exports: [NotificationService] })
export class NotificationModule {}
