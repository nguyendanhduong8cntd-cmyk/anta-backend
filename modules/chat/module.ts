import { Module } from '@nestjs/common';
import { ChatController } from './controller';
import { ChatService } from './service';
@Module({ controllers: [ChatController], providers: [ChatService], exports: [ChatService] })
export class ChatModule {}
