import { IsIn } from 'class-validator';

export class UpdateZoteroSyncDirectionDto {
  @IsIn(['read_only', 'two_way'], {
    message: 'syncDirection must be either read_only or two_way',
  })
  syncDirection!: 'read_only' | 'two_way';
}
