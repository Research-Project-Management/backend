import { IsNotEmpty, IsString } from 'class-validator';

export class ProjectRoomWsDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;
}
