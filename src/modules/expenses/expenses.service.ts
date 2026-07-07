import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { assertCapability } from '../../common/billing/capability.util';
import { planAllows } from '../billing/plans';

@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  list(orgId: string) {
    return this.prisma.withTenant(orgId, (tx) =>
      tx.expense.findMany({
        where: { organisationId: orgId },
        orderBy: { incurredAt: 'desc' },
      }),
    );
  }

  create(orgId: string, dto: CreateExpenseDto) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const org = await tx.organisation.findUnique({
        where: { id: orgId },
        select: { plan: true, subscribedUntil: true },
      });
      // Bookkeeping is a paid feature; receipts require a higher plan still.
      assertCapability(org, 'expenses');
      const canReceipt = planAllows(org?.plan, org?.subscribedUntil, 'receipts');
      return tx.expense.create({
        data: {
          organisationId: orgId,
          amount: BigInt(dto.amount),
          category: dto.category,
          incurredAt: dto.incurredAt ? new Date(dto.incurredAt) : new Date(),
          note: dto.note ?? null,
          receiptUrl: canReceipt ? dto.receiptUrl ?? null : null,
        },
      });
    });
  }

  async remove(orgId: string, id: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const res = await tx.expense.deleteMany({
        where: { id, organisationId: orgId },
      });
      if (res.count === 0) throw new NotFoundException('Expense not found');
      return { deleted: true };
    });
  }
}
