import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateExpenseDto {
  // Whole units (e.g. RWF), like invoice amounts.
  @IsInt()
  @Min(1)
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
}
