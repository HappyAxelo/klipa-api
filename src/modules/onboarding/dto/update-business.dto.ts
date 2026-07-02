import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class UpdateBusinessDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  businessName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^https:\/\//, { message: 'logoUrl must be an https URL' })
  logoUrl?: string;

  // Owner's name (stored on the user profile).
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;
}
