import { IsEnum, IsInt, IsOptional, Min, Max } from 'class-validator';

export enum StateReadStatus {
  UNREAD = 'unread',
  READING = 'reading',
  COMPLETED = 'completed',
}

export class UpdateStateDto {
  @IsOptional()
  @IsEnum(StateReadStatus, {
    message: 'readStatus must be one of: unread, reading, completed',
  })
  readStatus?: StateReadStatus;

  @IsOptional()
  @IsInt()
  @Min(0, { message: 'rating must be between 0 and 5' })
  @Max(5, { message: 'rating must be between 0 and 5' })
  rating?: number;
}

export interface StateResponse {
  readStatus: 'unread' | 'reading' | 'completed';
  rating: number;
  lastReadAt: string | null;
}

// Backward compatibility aliases
export const ItemReadStatus = StateReadStatus;
export type ItemReadStatus = StateReadStatus;
export const UpdateItemStateDto = UpdateStateDto;
export type UpdateItemStateDto = UpdateStateDto;
export type ItemStateResponse = StateResponse;

export const UserReadStatus = StateReadStatus;
export type UserReadStatus = StateReadStatus;
export const UpdateUserItemStateDto = UpdateStateDto;
export type UpdateUserItemStateDto = UpdateStateDto;
export type UserItemStateResponse = StateResponse;
