import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Single Prisma client for the app.
 *
 * `withTenant` is how every tenant-scoped query runs. It opens a transaction,
 * sets `app.current_org` for the life of that transaction (set_config with
 * is_local = true), then runs your callback against the transaction client.
 * Postgres RLS reads that value and refuses to return another org's rows.
 *
 * Always pass an org id you derived from the verified JWT — never one sent
 * by the client.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    await this.$connect();
  }

  async withTenant<T>(
    organisationId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      // Parameterised — set_config takes a value param, so no string building.
      await tx.$executeRaw`select set_config('app.current_org', ${organisationId}, true)`;
      return fn(tx);
    });
  }
}
