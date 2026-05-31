import { IsInt, Min } from 'class-validator';

export class RecordPaymentDto {
  // Whole RWF (minor units). Positive integer.
  @IsInt()
  @Min(1)
  amount: number;
}
