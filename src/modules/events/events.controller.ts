import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { SupabaseAuthGuard, AuthContext } from '../../common/auth/supabase.guard';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { PrismaService } from '../../common/database/prisma.service';

// Only names the app actually sends; anything else is rejected so the
// analytics can't be polluted by a tampered client.
const EVENT_NAMES = [
  'app_open',
  'screen',
  'invoice_create_opened',
  'invoice_created',
  'quotation_created',
  'invoice_sent',
  'payment_recorded',
  'expense_added',
  'ai_asked',
  'billing_viewed',
  'upgrade_clicked',
  'team_invited',
  // Growth loop: a new business signed up from an invoice/PDF/email link.
  'signup_from_invoice',
];

class EventDto {
  @IsIn(EVENT_NAMES)
  event: string;

  // Screen name for `screen` events (dashboard, invoices, customers, ...).
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z0-9_/-]+$/i)
  path?: string;

  @IsOptional()
  @IsIn(['android', 'ios', 'desktop', 'other'])
  device?: string;
}

class TrackDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => EventDto)
  events: EventDto[];
}

// Fire-and-forget usage beacons from the app. Auth required (ties events to
// a real user), org may still be null during onboarding.
@Controller('v1/events')
@UseGuards(SupabaseAuthGuard)
export class EventsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(202)
  async track(@CurrentUser() auth: AuthContext, @Body() dto: TrackDto) {
    await this.prisma.appEvent.createMany({
      data: dto.events.map((e) => ({
        userId: auth.userId,
        organisationId: auth.organisationId,
        event: e.event,
        path: e.path ?? null,
        device: e.device ?? null,
      })),
    });
    return { ok: true };
  }
}
