import { IsInt, Max, Min } from 'class-validator';

export class RecordPaymentDto {
  // Whole RWF (minor units). Positive integer.
  @IsInt()
  @Min(1)
  @Max(1000000000000)
  amount: number;
}
