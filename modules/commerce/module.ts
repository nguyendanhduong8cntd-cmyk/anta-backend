import { Module } from '@nestjs/common';
import { CommerceController } from './controller';
import { CommerceService } from './service';
@Module({ controllers: [CommerceController], providers: [CommerceService], exports: [CommerceService] })
export class CommerceModule {}
