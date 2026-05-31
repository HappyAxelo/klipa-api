import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class InvoiceNumberService {
  /**
   * Produces INV-YYYY-NNNN, sequential per organisation per year.
   *
   * MVP approach: take the highest existing number for the org this year and
   * add one, inside the same transaction as the insert. Good enough at launch
   * volume. If two invoices are created in the same millisecond you could get
   * a collision, which the unique (organisation_id, number) constraint catches;
   * harden later with a dedicated per-org counter row and SELECT ... FOR UPDATE.
   */
  async next(tx: Prisma.TransactionClient, orgId: string): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `INV-${year}-`;

    const last = await tx.invoice.findFirst({
      where: { organisationId: orgId, number: { startsWith: prefix } },
      orderBy: { number: 'desc' },
      select: { number: true },
    });

    const lastSeq = last ? parseInt(last.number.slice(prefix.length), 10) : 0;
    const next = (lastSeq + 1).toString().padStart(4, '0');
    return `${prefix}${next}`;
  }
}
