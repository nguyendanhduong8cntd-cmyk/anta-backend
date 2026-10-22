import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import express from 'express';
import { resolve } from 'node:path';
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
  // Rate limits are per client address. Behind a reverse proxy that address is in X-Forwarded-For, and it is believed
  // only for as many hops as there are proxies of ours: a larger number would let a client name its own address.
  app.getHttpAdapter().getInstance().set('trust proxy', config.trustedProxyHops);
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  app.use(helmet());
  app.use(requestContext);
  app.enableCors({ origin: config.corsOrigins, methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'Last-Event-ID'], exposedHeaders: ['X-Request-Id'] });
  // Admin/owner portal: static files only. Every action it performs goes through the authenticated /api/v1/admin API.
  app.use('/admin', express.static(resolve('apps/admin/public'), { index: 'index.html', maxAge: 0 }));
  // Venue-owner portal: static files only. Every action it performs goes through the authenticated /api/v1/owner API.
  app.use('/owner', express.static(resolve('apps/owner/public'), { index: 'index.html', maxAge: 0 }));
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
