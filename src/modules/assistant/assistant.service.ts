import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/database/prisma.service';
import { formatMoney } from '../../common/money/money';

interface Ctx {
  currency: string;
  collectedThisMonth: bigint;
  collectedLastMonth: bigint;
  outstanding: bigint;
  overdue: bigint;
  invoiceCount: number;
  unpaidCount: number;
  topDebtors: { name: string; amount: bigint }[];
  latePayers: { name: string; count: number }[];
  topExpenses: { category: string; amount: bigint }[];
  expensesThisMonth: bigint;
  forecastNextMonth: bigint;
}

// The founder wants clean, plain text in front of business owners: no em
// dashes, no decorative emoji (lightbulbs etc.), no markdown bullets/bold.
function cleanText(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, '. ')
    .replace(/[\u{1F4A1}\u{2728}\u{1F680}\u{1F4C8}\u{1F4C9}\u{1F4B0}\u{1F4A5}\u{1F525}\u{1F389}\u{2b50}\u{1F31F}]/gu, '')
    .replace(/\*\*/g, '')
    .replace(/^[-*•]\s+/gm, '')
    .replace(/\.\.+/g, '.')
    .replace(/  +/g, ' ')
    .trim();
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  aiEnabled(): boolean {
    return Boolean(this.config.get<string>('ANTHROPIC_API_KEY'));
  }

  // ---- Gather a compact snapshot of the business from real data ----
  private async gather(orgId: string): Promise<Ctx> {
    return this.prisma.withTenant(orgId, async (tx) => {
      const org = await tx.organisation.findUnique({ where: { id: orgId } });
      const currency = org?.currency ?? 'RWF';

      const invoices = await tx.invoice.findMany({
        where: { organisationId: orgId },
        include: { customer: true, payments: true },
      });
      const expenses = await tx.expense.findMany({ where: { organisationId: orgId } });

      const now = new Date();
      const monthKey = (d: Date) => d.getFullYear() * 12 + d.getMonth();
      const thisM = monthKey(now);
      const lastM = thisM - 1;

      let collectedThisMonth = 0n;
      let collectedLastMonth = 0n;
      let outstanding = 0n;
      let overdue = 0n;
      let unpaidCount = 0;
      const debtor = new Map<string, bigint>();
      const late = new Map<string, number>();

      for (const inv of invoices) {
        const paid = inv.payments.reduce((s, p) => s + p.amount, 0n);
        const due = inv.amountTotal - paid;
        for (const p of inv.payments) {
          const m = monthKey(new Date(p.paidAt ?? p.createdAt));
          if (m === thisM) collectedThisMonth += p.amount;
          else if (m === lastM) collectedLastMonth += p.amount;
        }
        if (inv.status !== 'draft' && due > 0n) {
          outstanding += due;
          unpaidCount += 1;
          const name = inv.customer?.name ?? 'Unknown';
          debtor.set(name, (debtor.get(name) ?? 0n) + due);
          if (new Date(inv.dueDate) < now) {
            overdue += due;
            late.set(name, (late.get(name) ?? 0) + 1);
          }
        }
      }

      const expenseByCat = new Map<string, bigint>();
      let expensesThisMonth = 0n;
      for (const e of expenses) {
        expenseByCat.set(e.category, (expenseByCat.get(e.category) ?? 0n) + e.amount);
        if (monthKey(new Date(e.incurredAt)) === thisM) expensesThisMonth += e.amount;
      }

      // Simple forecast: average of collections over the last 3 months.
      const byMonth = new Map<number, bigint>();
      for (const inv of invoices) {
        for (const p of inv.payments) {
          const m = monthKey(new Date(p.paidAt ?? p.createdAt));
          byMonth.set(m, (byMonth.get(m) ?? 0n) + p.amount);
        }
      }
      let sum3 = 0n;
      let n3 = 0;
      for (let i = 1; i <= 3; i++) {
        if (byMonth.has(thisM - i)) { sum3 += byMonth.get(thisM - i)!; n3++; }
      }
      const forecastNextMonth = n3 > 0 ? sum3 / BigInt(n3) : collectedThisMonth;

      const sortBig = (m: Map<string, bigint>) =>
        [...m.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1));

      return {
        currency,
        collectedThisMonth,
        collectedLastMonth,
        outstanding,
        overdue,
        invoiceCount: invoices.length,
        unpaidCount,
        topDebtors: sortBig(debtor).slice(0, 5).map(([name, amount]) => ({ name, amount })),
        latePayers: [...late.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([name, count]) => ({ name, count })),
        topExpenses: sortBig(expenseByCat).slice(0, 5).map(([category, amount]) => ({ category, amount })),
        expensesThisMonth,
        forecastNextMonth,
      };
    });
  }

  // ---- Structured insights for the dashboard card ----
  async insights(orgId: string) {
    const c = await this.gather(orgId);
    const fmt = (n: bigint) => formatMoney(n, c.currency);
    const profitThisMonth = c.collectedThisMonth - c.expensesThisMonth;
    const cards: { title: string; value: string; hint?: string }[] = [
      { title: 'Collected this month', value: fmt(c.collectedThisMonth),
        hint: c.collectedLastMonth > 0n
          ? `${c.collectedThisMonth >= c.collectedLastMonth ? '▲' : '▼'} vs ${fmt(c.collectedLastMonth)} last month` : undefined },
      { title: 'Outstanding (owed to you)', value: fmt(c.outstanding), hint: `${c.unpaidCount} unpaid invoice(s)` },
      { title: 'Overdue', value: fmt(c.overdue) },
      { title: 'Profit this month', value: fmt(profitThisMonth), hint: `after ${fmt(c.expensesThisMonth)} expenses` },
      { title: 'Projected next month', value: fmt(c.forecastNextMonth), hint: 'based on recent collections' },
    ];
    const tips: string[] = [];
    if (c.overdue > 0n && c.topDebtors.length) {
      tips.push(`Follow up ${c.topDebtors[0].name}. They owe you ${fmt(c.topDebtors[0].amount)}.`);
    }
    if (c.expensesThisMonth > c.collectedThisMonth && c.collectedThisMonth >= 0n) {
      tips.push('Spending is higher than income this month. Review your biggest expenses.');
    }
    if (c.topExpenses.length) {
      tips.push(`Your biggest expense category is ${c.topExpenses[0].category} (${fmt(c.topExpenses[0].amount)}).`);
    }
    if (!tips.length) tips.push('Send invoices and record payments. Your insights will sharpen as data grows.');
    return { cards, tips: tips.map(cleanText) };
  }

  // ---- Conversational answer ----
  async ask(orgId: string, question: string): Promise<{ answer: string; source: 'ai' | 'rule' }> {
    const c = await this.gather(orgId);
    const rule = this.ruleAnswer(question, c);
    if (this.aiEnabled()) {
      try {
        const answer = await this.claudeAnswer(question, c);
        if (answer) return { answer: cleanText(answer), source: 'ai' };
      } catch (e) {
        this.logger.warn(`AI answer failed, using rule fallback: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { answer: cleanText(rule), source: 'rule' };
  }

  private ruleAnswer(q: string, c: Ctx): string {
    const fmt = (n: bigint) => formatMoney(n, c.currency);
    const s = q.toLowerCase();
    if (/(where.*money|what happen.*money|money go|cash ?flow)/.test(s)) {
      const net = c.collectedThisMonth - c.expensesThisMonth;
      const spend = c.topExpenses.length
        ? ` Your spending went mostly to ${c.topExpenses.map((e) => `${e.category} (${fmt(e.amount)})`).join(', ')}.`
        : '';
      return `This month ${fmt(c.collectedThisMonth)} came in and ${fmt(c.expensesThisMonth)} went out, leaving you ${fmt(net)}.${spend} You are still owed ${fmt(c.outstanding)} by customers.`;
    }
    if (/(profit|make|earn)/.test(s)) {
      const profit = c.collectedThisMonth - c.expensesThisMonth;
      return `This month you collected ${fmt(c.collectedThisMonth)} and spent ${fmt(c.expensesThisMonth)}, so your profit is ${fmt(profit)}.`;
    }
    if (/(owe|owes|owed|debt|outstanding|unpaid)/.test(s)) {
      if (!c.topDebtors.length) return 'No one owes you right now. All sent invoices are paid.';
      const list = c.topDebtors.map((d) => `${d.name} (${fmt(d.amount)})`).join(', ');
      return `You are owed ${fmt(c.outstanding)} across ${c.unpaidCount} invoice(s). Top: ${list}.`;
    }
    if (/(late|slow)/.test(s)) {
      if (!c.latePayers.length) return 'No customers are late right now.';
      return `Customers who pay late: ${c.latePayers.map((l) => `${l.name} (${l.count} overdue)`).join(', ')}.`;
    }
    if (/(expense|spend|cost|biggest)/.test(s)) {
      if (!c.topExpenses.length) return 'No expenses recorded yet. Add expenses to track your costs.';
      return `Your biggest expenses: ${c.topExpenses.map((e) => `${e.category} (${fmt(e.amount)})`).join(', ')}.`;
    }
    if (/(predict|forecast|next month|projection)/.test(s)) {
      return `Based on your recent collections, next month is projected around ${fmt(c.forecastNextMonth)}.`;
    }
    return `This month: collected ${fmt(c.collectedThisMonth)}, outstanding ${fmt(c.outstanding)} (${c.unpaidCount} unpaid), overdue ${fmt(c.overdue)}. Ask me about profit, who owes you, late payers, expenses, where your money went, or next month's forecast.`;
  }

  private async claudeAnswer(question: string, c: Ctx): Promise<string | null> {
    const key = this.config.getOrThrow<string>('ANTHROPIC_API_KEY');
    const model = this.config.get<string>('AI_MODEL', 'claude-sonnet-5');
    const fmt = (n: bigint) => formatMoney(n, c.currency);
    const context = [
      `Currency: ${c.currency}`,
      `Collected this month: ${fmt(c.collectedThisMonth)}`,
      `Collected last month: ${fmt(c.collectedLastMonth)}`,
      `Expenses this month: ${fmt(c.expensesThisMonth)}`,
      `Total outstanding (owed to the business): ${fmt(c.outstanding)} across ${c.unpaidCount} unpaid invoices`,
      `Overdue amount: ${fmt(c.overdue)}`,
      `Top debtors: ${c.topDebtors.map((d) => `${d.name}=${fmt(d.amount)}`).join('; ') || 'none'}`,
      `Frequent late payers: ${c.latePayers.map((l) => `${l.name} (${l.count})`).join('; ') || 'none'}`,
      `Top expense categories: ${c.topExpenses.map((e) => `${e.category}=${fmt(e.amount)}`).join('; ') || 'none'}`,
      `Projected next month: ${fmt(c.forecastNextMonth)}`,
    ].join('\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        system:
          'You are Klipwa AI, the business assistant inside Klipwa, an invoicing and bookkeeping app for African small businesses. ' +
          'Your job is to help owners understand exactly what happens to their money. ' +
          'Answer ONLY from the DATA provided; every number you state must appear in the DATA, with its currency. ' +
          'Never invent, estimate, or extrapolate numbers beyond what is given. ' +
          'If the DATA does not cover the question, say plainly that the answer is not in their records yet and name the one thing to record in Klipwa to get it. ' +
          'Be short and practical: 2 to 4 plain sentences a busy shop owner can act on today. ' +
          'Write in the same language the question was asked in (English, Kinyarwanda, French, or Swahili). ' +
          'Plain text only: no markdown, no bullet lists, no emojis, no em dashes.',
        messages: [
          { role: 'user', content: `DATA:\n${context}\n\nQUESTION: ${question}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body: any = await res.json();
    const text = body?.content?.[0]?.text;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  }
}
