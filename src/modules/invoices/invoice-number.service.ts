import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class InvoiceNumberService {
  /**
   * Produces INV-YYYY-NNNN, sequential per organisation per year.
   *
   * It finds the highest existing sequence for the org this year by scanning
   * the actual numbers (parsed as integers, not string-sorted), then adds one
   * plus an optional offset. The offset lets the caller retry on a unique-
   * constraint collision: bump the offset and try again. This survives any
   * out-of-sync state from earlier failed inserts.
   */
  async next(
    tx: Prisma.TransactionClient,
    orgId: string,
    offset = 0,
    kind: 'INV' | 'QUO' = 'INV',
  ): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `${kind}-${year}-`;

    const existing = await tx.invoice.findMany({
      where: { organisationId: orgId, number: { startsWith: prefix } },
      select: { number: true },
    });

    let maxSeq = 0;
    for (const row of existing) {
      const seq = parseInt(row.number.slice(prefix.length), 10);
      if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }

    const next = (maxSeq + 1 + offset).toString().padStart(4, '0');
    return `${prefix}${next}`;
  }
}
