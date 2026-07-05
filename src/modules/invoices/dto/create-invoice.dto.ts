import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class CreateItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  description: string;

  @IsInt()
  @Min(1)
  @Max(100000)
  quantity: number;

  // Stored as BigInt in DB. Client sends an integer (whole RWF, no decimals).
  @IsInt()
  @Min(0)
  @Max(1000000000000) // 1 trillion minor units — sane upper bound
  unitAmount: number;
}

export class CreateInvoiceDto {
  @ValidateNested()
  @Type(() => CreateCustomerDto)
  customer: CreateCustomerDto;

  // At least one line item required. Total is computed server-side.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateItemDto)
  items: CreateItemDto[];

  @IsDateString()
  dueDate: string;

  // Bill in any currency; defaults to the business's own currency.
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  currency?: string;

  @IsOptional()
  @IsBoolean()
  send?: boolean;

  // "quotation" produces a QUO-… document that doesn't count toward the free
  // invoice limit and can later be converted into an invoice.
  @IsOptional()
  @IsIn(['invoice', 'quotation'])
  docType?: 'invoice' | 'quotation';

  // Tax percentage (e.g. 18 for 18% VAT). Applied after discount.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRate?: number;

  // Flat discount amount in whole units (minor units), applied before tax.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000000000)
  discount?: number;
}
