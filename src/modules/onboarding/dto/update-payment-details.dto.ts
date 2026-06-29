import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePaymentDetailsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  momoCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankAccount?: string;
}
