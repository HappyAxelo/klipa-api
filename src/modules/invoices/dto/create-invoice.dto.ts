import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
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

  @IsOptional()
  @IsBoolean()
  send?: boolean;
}
