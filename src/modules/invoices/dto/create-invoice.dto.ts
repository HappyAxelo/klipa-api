import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class InlineCustomerDto {
  @IsString()
  @MaxLength(160)
  name: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;
}

export class CreateInvoiceDto {
  @ValidateNested()
  @Type(() => InlineCustomerDto)
  customer: InlineCustomerDto;

  // Whole RWF (minor units). Positive integer.
  @IsInt()
  @Min(1)
  amount: number;

  @IsDateString()
  dueDate: string; // YYYY-MM-DD

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // true sends immediately; false saves a draft.
  @IsOptional()
  @IsBoolean()
  send?: boolean;
}
