import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
export class ConversationDto {
  @ApiProperty() @IsString() @Length(2, 100) title!: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(49) @IsUUID('4', { each: true }) memberIds!: string[];
}
export class MessageDto { @ApiProperty() @IsString() @Length(1, 4000) body!: string; }
export class ReadDto { @ApiProperty() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) seq!: number; }
