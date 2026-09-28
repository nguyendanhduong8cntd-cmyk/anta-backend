import { Module } from '@nestjs/common';
import { IdentityController } from './controller';
import { IdentityService } from './service';
@Module({ controllers: [IdentityController], providers: [IdentityService], exports: [IdentityService] })
export class IdentityModule {}
