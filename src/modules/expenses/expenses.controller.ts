import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/auth/supabase.guard';
import { CurrentOrg } from '../../common/auth/current-user.decorator';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { jsonSafe } from '../../common/money/money';

@Controller('v1/expenses')
@UseGuards(SupabaseAuthGuard)
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  async list(@CurrentOrg() orgId: string) {
    return jsonSafe(await this.expenses.list(orgId));
  }

  @Post()
  async create(@CurrentOrg() orgId: string, @Body() dto: CreateExpenseDto) {
    return jsonSafe(await this.expenses.create(orgId, dto));
  }

  @Delete(':id')
  async remove(@CurrentOrg() orgId: string, @Param('id') id: string) {
    return jsonSafe(await this.expenses.remove(orgId, id));
  }
}
