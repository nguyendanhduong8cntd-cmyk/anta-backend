import { Module } from '@nestjs/common';
import { CourtImageController, MediaController } from './controller';
import { MediaService } from './service';
@Module({ controllers: [MediaController, CourtImageController], providers: [MediaService], exports: [MediaService] })
export class MediaModule {}
