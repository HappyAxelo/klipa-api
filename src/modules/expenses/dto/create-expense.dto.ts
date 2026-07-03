import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateExpenseDto {
  // Whole units (e.g. RWF), like invoice amounts.
  @IsInt()
  @Min(1)
  @Max(1000000000000)
  amount: number;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  category: string;

  @IsOptional()
  @IsDateString()
  incurredAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  // Photo of the paper receipt, uploaded to storage by the app.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^https:\/\//, { message: 'receiptUrl must be an https URL' })
  receiptUrl?: string;
}
