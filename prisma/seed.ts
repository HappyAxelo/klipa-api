// Seeds one organisation with customers and invoices so you can confirm
// data persists. Run: npm run seed
// Safe to run repeatedly — it upserts a fixed demo org.
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const DEMO_USER = '00000000-0000-0000-0000-000000000001';

async function main() {
  await prisma.userProfile.upsert({
    where: { id: DEMO_USER },
    update: {},
    create: { id: DEMO_USER, fullName: 'Demo Owner', email: 'demo@k-lipa.rw' },
  });

  // one demo org (delete old demo data first for a clean seed)
  const existing = await prisma.organisation.findFirst({ where: { name: 'K-Lipa Demo Co' } });
  if (existing) await prisma.organisation.delete({ where: { id: existing.id } });

  const org = await prisma.organisation.create({
    data: { name: 'K-Lipa Demo Co', category: 'Agency', currency: 'RWF', plan: 'growth' },
  });
  await prisma.membership.create({
    data: { organisationId: org.id, userId: DEMO_USER, role: 'owner' },
  });
  await prisma.consentRecord.create({
    data: { userId: DEMO_USER, termsVersion: '2026-05-01', language: 'en' },
  });

  const acme = await prisma.customer.create({
    data: { organisationId: org.id, name: 'Acme Ltd', email: 'pay@acme.rw' },
  });
  const beta = await prisma.customer.create({
    data: { organisationId: org.id, name: 'Beta Co', email: 'finance@beta.rw' },
  });

  const day = (n: number) => new Date(Date.now() + n * 86400000);

  await prisma.invoice.create({
    data: {
      organisationId: org.id, customerId: acme.id, number: 'INV-2026-0001',
      amountTotal: 450000n, currency: 'RWF', dueDate: day(-14), status: 'sent',
      description: 'Website design', publicToken: 'seedtoken0001',
      payments: { create: [{ amount: 200000n, method: 'manual' }] }, // partial
    },
  });
  await prisma.invoice.create({
    data: {
      organisationId: org.id, customerId: beta.id, number: 'INV-2026-0002',
      amountTotal: 900000n, currency: 'RWF', dueDate: day(-2), status: 'sent',
      description: 'Brand identity', publicToken: 'seedtoken0002', paidAt: new Date(),
      payments: { create: [{ amount: 900000n, method: 'manual' }] }, // paid
    },
  });

  console.log('Seeded org:', org.id);
  console.log('Now query GET /v1/invoices (with a token for this user) to confirm persistence.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
