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

  // Reads the API key defensively: trims whitespace, strips accidental quotes
  // and a pasted "ANTHROPIC_API_KEY=" prefix (a paste slip that has happened
  // with other env vars on this project before).
  private apiKey(): string | null {
    let k = this.config.get<string>('ANTHROPIC_API_KEY') ?? '';
    k = k.trim().replace(/^["']|["']$/g, '');
    if (k.toUpperCase().startsWith('ANTHROPIC_API_KEY=')) k = k.slice('ANTHROPIC_API_KEY='.length).trim();
    return k || null;
  }

  private model(): string {
    const m = (this.config.get<string>('AI_MODEL') ?? '').trim();
    return m || 'claude-sonnet-5';
  }

  aiEnabled(): boolean {
    return Boolean(this.apiKey());
  }

  /** Owner diagnostic: pings Anthropic with the configured key and reports
   *  what happened, never echoing the key itself. */
  async aiCheck(): Promise<{ ok: boolean; configured: boolean; model: string; status?: number; hint?: string }> {
    const key = this.apiKey();
    const model = this.model();
    if (!key) return { ok: false, configured: false, model, hint: 'ANTHROPIC_API_KEY is not set on Railway.' };
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Say ok' }] }),
      });
      if (res.ok) return { ok: true, configured: true, model };
      const body = (await res.text()).slice(0, 200);
      const hint =
        /credit balance/i.test(body)
          ? 'Your Anthropic account has no API credits. Go to console.anthropic.com > Plans & Billing and buy credits; the assistant starts working immediately after.'
        : res.status === 401 ? 'The API key is invalid. Re-copy it from console.anthropic.com and paste only the key value.'
        : res.status === 404 ? `Model "${model}" was not found. Remove AI_MODEL or set it to a valid model id.`
        : res.status === 429 ? 'Rate limited. Try again in a minute or check your Anthropic plan.'
        : `Anthropic returned ${res.status}.`;
      return { ok: false, configured: true, model, status: res.status, hint: `${hint} (${body})` };
    } catch (e) {
      return { ok: false, configured: true, model, hint: `Network error calling Anthropic: ${e instanceof Error ? e.message : e}` };
    }
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

  // ---- Conversation memory ----
  // How many past turns the model sees. Enough for real follow-ups
  // ("and last month?", "what should I do about him?") without bloating cost.
  private static readonly HISTORY_TURNS = 12;

  /** Recent chat for this user in this org, oldest first (for the chat UI). */
  history(orgId: string, userId: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const rows = await tx.assistantMessage.findMany({
        where: { organisationId: orgId, userId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      return rows.reverse().map((m) => ({
        role: m.role,
        content: m.content,
        at: m.createdAt,
      }));
    });
  }

  clearHistory(orgId: string, userId: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const res = await tx.assistantMessage.deleteMany({
        where: { organisationId: orgId, userId },
      });
      return { cleared: res.count };
    });
  }

  // Saving is best-effort: a hiccup here must never break the answer.
  // Explicit timestamps 1ms apart: createMany would give both rows the same
  // now(), making question/answer order ambiguous on read-back.
  private async remember(orgId: string, userId: string, question: string, answer: string) {
    try {
      const asked = new Date();
      const answered = new Date(asked.getTime() + 1);
      await this.prisma.withTenant(orgId, (tx) =>
        tx.assistantMessage.createMany({
          data: [
            { organisationId: orgId, userId, role: 'user', content: question.slice(0, 2000), createdAt: asked },
            { organisationId: orgId, userId, role: 'assistant', content: answer.slice(0, 4000), createdAt: answered },
          ],
        }),
      );
    } catch (e) {
      this.logger.warn(`Could not save chat memory: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ---- Conversational answer ----
  async ask(
    orgId: string,
    userId: string,
    question: string,
  ): Promise<{ answer: string; source: 'ai' | 'rule' }> {
    const c = await this.gather(orgId);
    const rule = this.ruleAnswer(question, c);
    let result: { answer: string; source: 'ai' | 'rule' } | null = null;
    if (this.aiEnabled()) {
      try {
        const history = await this.history(orgId, userId).catch(() => []);
        const answer = await this.claudeAnswer(question, c, history);
        if (answer) result = { answer: cleanText(answer), source: 'ai' };
      } catch (e) {
        this.logger.warn(`AI answer failed, using rule fallback: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!result) result = { answer: cleanText(rule), source: 'rule' };
    await this.remember(orgId, userId, question, result.answer);
    return result;
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

  private async claudeAnswer(
    question: string,
    c: Ctx,
    history: { role: string; content: string }[] = [],
  ): Promise<string | null> {
    const key = this.apiKey();
    if (!key) return null;
    const model = this.model();
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
          'Earlier conversation turns are provided for context and follow-up questions, but the DATA block in the latest message is always current and always wins over anything said earlier. ' +
          'If the DATA does not cover the question, say plainly that the answer is not in their records yet and name the one thing to record in Klipwa to get it. ' +
          'Be short and practical: 2 to 4 plain sentences a busy shop owner can act on today. ' +
          'Write in the same language the question was asked in (English, Kinyarwanda, French, or Swahili). ' +
          'Plain text only: no markdown, no bullet lists, no emojis, no em dashes.',
        messages: [
          // Recent conversation, oldest first, so follow-ups make sense.
          // Trim to whole turns starting on a user message.
          ...(() => {
            const h = history.slice(-AssistantService.HISTORY_TURNS);
            while (h.length && h[0].role !== 'user') h.shift();
            return h.map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content.slice(0, 600),
            }));
          })(),
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
