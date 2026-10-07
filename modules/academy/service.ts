import { Injectable } from '@nestjs/common';
import { Database } from '../../packages/database';
import { Idempotency } from '../../packages/idempotency';
import { AccessService } from '../../packages/access';
import { ApiError, invariant } from '../../packages/contracts/errors';
import { emitEvent } from '../../packages/events';
import { CreateCenterDto, CreateClassDto, CreateCourseDto } from './dto';

@Injectable()
export class AcademyService {
  constructor(private readonly db: Database, private readonly access: AccessService, private readonly idem: Idempotency) {}
  async centers() { return (await this.db.query('SELECT * FROM academy.centers WHERE active ORDER BY name,id')).rows; }
  async center(id: string) {
    const row = (await this.db.query('SELECT * FROM academy.centers WHERE id=$1 AND active', [id])).rows[0];
    invariant(row, 'NOT_FOUND', 'Academy center not found', 404); return row;
  }
  async coaches(centerId?: string) {
    return (await this.db.query(`SELECT c.id,c.center_id,c.bio,u.display_name FROM academy.coaches c
      JOIN identity.users u ON u.id=c.user_id WHERE c.active AND ($1::uuid IS NULL OR c.center_id=$1) ORDER BY u.display_name`, [centerId || null])).rows;
  }
  async courses(centerId?: string) {
    return (await this.db.query('SELECT * FROM academy.courses WHERE active AND ($1::uuid IS NULL OR center_id=$1) ORDER BY name,id', [centerId || null])).rows;
  }
  async course(id: string) {
    const row = (await this.db.query('SELECT * FROM academy.courses WHERE id=$1 AND active', [id])).rows[0];
    invariant(row, 'NOT_FOUND', 'Course not found', 404); return row;
  }
  async classes(courseId?: string) {
    return (await this.db.query("SELECT * FROM academy.classes WHERE status='OPEN' AND ($1::uuid IS NULL OR course_id=$1) ORDER BY starts_at,id", [courseId || null])).rows;
  }
  async class(id: string) {
    const row = (await this.db.query('SELECT * FROM academy.classes WHERE id=$1', [id])).rows[0];
    invariant(row, 'NOT_FOUND', 'Class not found', 404); return row;
  }
  async createCenter(userId: string, dto: CreateCenterDto, requestId: string) {
    return this.db.transaction(async tx => {
      await this.access.owner(userId, dto.branchId, tx);
      const row = (await tx.query('INSERT INTO academy.centers(branch_id,name,description) VALUES($1,$2,$3) RETURNING *',
        [dto.branchId, dto.name.trim(), dto.description])).rows[0];
      await this.access.audit(tx, userId, 'academy.center.create', 'center', row.id, requestId);
      return row;
    });
  }
  async createCourse(userId: string, dto: CreateCourseDto, requestId: string) {
    return this.db.transaction(async tx => {
      const center = (await tx.query('SELECT * FROM academy.centers WHERE id=$1 AND active', [dto.centerId])).rows[0];
      invariant(center, 'NOT_FOUND', 'Center not found', 404);
      await this.access.staff(userId, center.branch_id, tx);
      const sport = await tx.query('SELECT 1 FROM catalog.sports WHERE id=$1', [dto.sportId]);
      invariant(sport.rowCount, 'NOT_FOUND', 'Sport not found', 404);
      const row = (await tx.query('INSERT INTO academy.courses(center_id,sport_id,name,description) VALUES($1,$2,$3,$4) RETURNING *',
        [dto.centerId, dto.sportId, dto.name.trim(), dto.description])).rows[0];
      await this.access.audit(tx, userId, 'academy.course.create', 'course', row.id, requestId);
      return row;
    });
  }
  async createClass(userId: string, dto: CreateClassDto, requestId: string) {
    const start = new Date(dto.startsAt), end = new Date(dto.endsAt);
    invariant(Number.isFinite(start.getTime()) && end > start && start.getTime() > Date.now() && end.getTime() - start.getTime() <= 90 * 86400000,
      'INVALID_CLASS_TIME', 'Class must be future and at most 90 days', 400);
    return this.db.transaction(async tx => {
      const course = (await tx.query('SELECT c.*,center.branch_id FROM academy.courses c JOIN academy.centers center ON center.id=c.center_id WHERE c.id=$1 AND c.active', [dto.courseId])).rows[0];
      invariant(course, 'NOT_FOUND', 'Course not found', 404);
      await this.access.staff(userId, course.branch_id, tx);
      const row = (await tx.query('INSERT INTO academy.classes(course_id,starts_at,ends_at,capacity,price) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [dto.courseId, start, end, dto.capacity, dto.price])).rows[0];
      await this.access.audit(tx, userId, 'academy.class.create', 'class', row.id, requestId);
      return row;
    });
  }
  async enroll(userId: string, classId: string, key: string | undefined, requestId: string) {
    return this.idem.run(userId, `academy-enroll:${classId}`, key, { classId }, async tx => {
      const classRow = (await tx.query('SELECT * FROM academy.classes WHERE id=$1 FOR UPDATE', [classId])).rows[0];
      invariant(classRow, 'NOT_FOUND', 'Class not found', 404);
      invariant(classRow.status === 'OPEN' && classRow.starts_at.getTime() > Date.now(), 'CLASS_CLOSED', 'Class is no longer open');
      if (classRow.price > 0) throw new ApiError('PAYMENT_PROVIDER_REQUIRED', 'Paid class enrollment is not configured', 503);
      const existing = (await tx.query('SELECT * FROM academy.enrollments WHERE class_id=$1 AND user_id=$2', [classId, userId])).rows[0];
      if (existing?.status === 'ENROLLED') return existing;
      const count = (await tx.query("SELECT count(*)::int AS n FROM academy.enrollments WHERE class_id=$1 AND status='ENROLLED'", [classId])).rows[0].n;
      invariant(count < classRow.capacity, 'CLASS_FULL', 'Class has reached capacity');
      const row = (await tx.query(`INSERT INTO academy.enrollments(class_id,user_id,status) VALUES($1,$2,'ENROLLED')
        ON CONFLICT(class_id,user_id) DO UPDATE SET status='ENROLLED',updated_at=now(),version=academy.enrollments.version+1 RETURNING *`, [classId, userId])).rows[0];
      await emitEvent(tx, userId, 'academy.enrolled', { enrollmentId: row.id, classId }, requestId);
      return row;
    });
  }
  async cancel(userId: string, enrollmentId: string) {
    return this.db.transaction(async tx => {
      const ref = (await tx.query('SELECT class_id FROM academy.enrollments WHERE id=$1 AND user_id=$2', [enrollmentId, userId])).rows[0];
      invariant(ref, 'NOT_FOUND', 'Enrollment not found', 404);
      const cls = (await tx.query('SELECT * FROM academy.classes WHERE id=$1 FOR UPDATE', [ref.class_id])).rows[0];
      invariant(cls.starts_at.getTime() > Date.now(), 'CLASS_STARTED', 'Class has already started');
      return (await tx.query("UPDATE academy.enrollments SET status='CANCELLED',updated_at=now(),version=version+1 WHERE id=$1 AND user_id=$2 RETURNING *", [enrollmentId, userId])).rows[0];
    });
  }
  async sessions(userId: string) {
    return (await this.db.query(`SELECT s.*,e.id AS enrollment_id FROM academy.class_sessions s JOIN academy.enrollments e ON e.class_id=s.class_id
      WHERE e.user_id=$1 AND e.status='ENROLLED' AND s.ends_at>now() ORDER BY s.starts_at`, [userId])).rows;
  }
  async addSession(userId: string, classId: string, startsAt: string, endsAt: string, requestId: string) {
    const start = new Date(startsAt), end = new Date(endsAt);
    invariant(Number.isFinite(start.getTime()) && end > start, 'INVALID_SESSION_TIME', 'Invalid session time', 400);
    return this.db.transaction(async tx => {
      const cls = (await tx.query(`SELECT cl.*,center.branch_id FROM academy.classes cl JOIN academy.courses c ON c.id=cl.course_id
        JOIN academy.centers center ON center.id=c.center_id WHERE cl.id=$1 FOR UPDATE OF cl`, [classId])).rows[0];
      invariant(cls, 'NOT_FOUND', 'Class not found', 404);
      await this.access.staff(userId, cls.branch_id, tx);
      invariant(cls.status === 'OPEN' && start >= cls.starts_at && end <= cls.ends_at, 'INVALID_SESSION_TIME', 'Session must fall within open class', 400);
      const row = (await tx.query('INSERT INTO academy.class_sessions(class_id,starts_at,ends_at) VALUES($1,$2,$3) RETURNING *', [classId, start, end])).rows[0];
      await this.access.audit(tx, userId, 'academy.session.create', 'session', row.id, requestId);
      return row;
    });
  }
  async markAttendance(userId: string, sessionId: string, enrollmentId: string, present: boolean, requestId: string) {
    return this.db.transaction(async tx => {
      const session = (await tx.query(`SELECT s.*,center.branch_id FROM academy.class_sessions s JOIN academy.classes cl ON cl.id=s.class_id
        JOIN academy.courses c ON c.id=cl.course_id JOIN academy.centers center ON center.id=c.center_id WHERE s.id=$1`, [sessionId])).rows[0];
      invariant(session, 'NOT_FOUND', 'Session not found', 404);
      await this.access.staff(userId, session.branch_id, tx);
      const enrollment = (await tx.query("SELECT 1 FROM academy.enrollments WHERE id=$1 AND class_id=$2 AND status='ENROLLED'", [enrollmentId, session.class_id])).rows[0];
      invariant(enrollment, 'NOT_FOUND', 'Enrollment not found', 404);
      const row = (await tx.query(`INSERT INTO academy.attendance(session_id,enrollment_id,present,marked_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(session_id,enrollment_id) DO UPDATE SET present=excluded.present,marked_by=excluded.marked_by,created_at=now() RETURNING *`,
        [sessionId, enrollmentId, present, userId])).rows[0];
      await this.access.audit(tx, userId, 'academy.attendance.mark', 'session', sessionId, requestId);
      return row;
    });
  }
}
