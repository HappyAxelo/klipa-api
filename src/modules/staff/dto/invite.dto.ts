import { IsEmail, IsIn, IsOptional } from 'class-validator';

export class InviteDto {
  @IsEmail()
  email: string;

  // Only admin/member can be invited; the owner role is reserved for the founder.
  @IsOptional()
  @IsIn(['admin', 'member'])
  role?: 'admin' | 'member';
}
