import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/database/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  list(orgId: string, search?: string) {
    return this.prisma.withTenant(orgId, (tx) =>
      tx.customer.findMany({
        where: search
          ? { name: { contains: search, mode: 'insensitive' } }
          : undefined,
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  create(orgId: string, dto: CreateCustomerDto) {
    return this.prisma.withTenant(orgId, (tx) =>
      tx.customer.create({
        data: { organisationId: orgId, ...dto },
      }),
    );
  }

  /**
   * Find a customer by email within the org, or create one. This is what makes
   * 30-second invoicing work: the user never stops to create a customer first.
   */
  async findOrCreate(
    tx: Prisma.TransactionClient,
    orgId: string,
    data: { name: string; email?: string | null; phone?: string | null },
  ) {
    if (data.email) {
      const existing = await tx.customer.findFirst({
        where: { email: data.email },
      });
      if (existing) return existing;
    }
    return tx.customer.create({
      data: {
        organisationId: orgId,
        name: data.name,
        email: data.email ?? null,
        phone: data.phone ?? null,
      },
    });
  }

  async profile(orgId: string, customerId: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        include: {
          invoices: { orderBy: { createdAt: 'desc' } },
        },
      });
      if (!customer) throw new NotFoundException('Customer not found');

      // Balance is computed, never stored.
      const balance = await tx.$queryRaw<
        { total_invoiced: bigint; total_paid: bigint; outstanding: bigint }[]
      >`select total_invoiced, total_paid, outstanding
        from customer_balance where customer_id = ${customerId}::uuid`;

      return { ...customer, balance: balance[0] ?? null };
    });
  }
}
