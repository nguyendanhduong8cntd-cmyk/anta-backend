import { ArgumentsHost, CallHandler, Catch, ExceptionFilter, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../contracts/errors';
import { AuthRequest } from '../auth/guard';
import { digest } from '../auth/crypto';
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(incoming) ? incoming : randomUUID();
  (req as AuthRequest).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  const started = performance.now();
  res.on('finish', () => console.log(JSON.stringify({ event: 'http.request', requestId, method: req.method,
    route: req.route?.path || 'unmatched', status: res.statusCode, latencyMs: Math.round(performance.now() - started),
    userHash: (req as AuthRequest).principal ? digest((req as AuthRequest).principal.userId).slice(0, 16) : undefined })));
  next();
}
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    return next.handle().pipe(map(data => ({ data: data ?? null, meta: { requestId: req.requestId }, error: null })));
  }
}
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<AuthRequest>();
    const res = host.switchToHttp().getResponse<Response>();
    const pgCode = (exception as { code?: string })?.code;
    let status = exception instanceof HttpException ? exception.getStatus() : 500;
    let code = exception instanceof ApiError ? exception.code : status === 400 ? 'VALIDATION_FAILED' : status === 404 ? 'NOT_FOUND' : status === 503 ? 'DEPENDENCY_UNAVAILABLE' : 'INTERNAL_ERROR';
    let message = exception instanceof ApiError ? exception.message : status < 500 ? 'Invalid request' : 'Internal server error';
    if (pgCode === '23P01') { status = 409; code = 'SLOT_UNAVAILABLE'; message = 'The selected slot is no longer available'; }
    if (pgCode === '23505') { status = 409; code = 'CONFLICT'; message = 'Resource already exists'; }
    if (status >= 500) console.error(JSON.stringify({ event: 'http.error', requestId: req.requestId, code,
      errorType: exception instanceof Error ? exception.constructor.name : 'UnknownError' }));
    res.status(status).json({ data: null, meta: { requestId: req.requestId }, error: { code, message } });
  }
}
