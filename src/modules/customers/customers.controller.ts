import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/auth/supabase.guard';
import { CurrentOrg } from '../../common/auth/current-user.decorator';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { jsonSafe } from '../../common/money/money';

@Controller('v1/customers')
@UseGuards(SupabaseAuthGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  async list(@CurrentOrg() orgId: string, @Query('search') search?: string) {
    return jsonSafe(await this.customers.list(orgId, search));
  }

  @Post()
  async create(@CurrentOrg() orgId: string, @Body() dto: CreateCustomerDto) {
    return jsonSafe(await this.customers.create(orgId, dto));
  }

  @Get(':id')
  async profile(@CurrentOrg() orgId: string, @Param('id') id: string) {
    return jsonSafe(await this.customers.profile(orgId, id));
  }
}
