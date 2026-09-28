import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { ApiModule } from './module';
import { loadConfig } from '../../packages/config';
import { ApiExceptionFilter, EnvelopeInterceptor, requestContext } from '../../packages/observability/http';
import { ApiError } from '../../packages/contracts/errors';
import { RedisService } from '../../packages/redis';
import { Request, Response, NextFunction } from 'express';
import { digest } from '../../packages/auth/crypto';
import { buildOpenApi } from '../../packages/contracts/openapi';
export async function createApplication(): Promise<INestApplication> {
  const config = loadConfig();
  const app = await NestFactory.create(ApiModule, { rawBody: true, logger: ['warn', 'error'] });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  app.use(helmet());
  app.use(requestContext);
  app.enableCors({ origin: config.corsOrigins, methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'Last-Event-ID'], exposedHeaders: ['X-Request-Id'] });
  const redis = app.get(RedisService);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/v1/health/')) return next();
    redis.rateLimit(`http:ip:${digest(req.ip || 'unknown')}`, 180, 60000).then(() => next()).catch(error => {
      const limited = error instanceof ApiError;
      res.status(limited ? 429 : 503).json({ data: null, meta: { requestId: (req as any).requestId }, error: {
        code: limited ? 'RATE_LIMITED' : 'DEPENDENCY_UNAVAILABLE', message: 'Please try again later' } });
    });
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
    forbidUnknownValues: true, validationError: { target: false, value: false },
    exceptionFactory: () => new ApiError('VALIDATION_FAILED', 'Invalid request payload or query', 400) }));
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.useGlobalFilters(new ApiExceptionFilter());
  if (!config.production) SwaggerModule.setup('docs', app, buildOpenApi(app));
  return app;
}
