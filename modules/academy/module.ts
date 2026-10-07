import { Module } from '@nestjs/common';
import { AcademyController } from './controller';
import { AcademyService } from './service';
@Module({ controllers: [AcademyController], providers: [AcademyService], exports: [AcademyService] })
export class AcademyModule {}
