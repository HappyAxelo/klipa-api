import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreateOnboardingDto {
  @IsString()
  @MaxLength(120)
  businessName: string;

  @IsString()
  @MaxLength(80)
  category: string;

  @IsString()
  @Length(3, 3)
  currency: string; // ISO 4217, e.g. RWF

  @IsString()
  @MaxLength(120)
  fullName: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  // Consent captured on the Terms screen. Required: a user cannot onboard
  // without having accepted, and we store exactly what they accepted.
  @IsString()
  termsVersion: string; // e.g. "2026-05-01"

  @IsIn(['en', 'rw', 'fr', 'sw'])
  consentLanguage: string;
}
