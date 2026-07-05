import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { SupabaseAuthGuard, AuthContext } from '../../common/auth/supabase.guard';
import { CurrentOrg, CurrentUser } from '../../common/auth/current-user.decorator';
import { PushService } from './push.service';

class SubscribeDto {
  @IsString() @MaxLength(1000) endpoint: string;
  @IsString() @MaxLength(300) p256dh: string;
  @IsString() @MaxLength(200) auth: string;
}

class UnsubscribeDto {
  @IsString() @MaxLength(1000) endpoint: string;
}

@Controller('v1/push')
export class PushController {
  constructor(private readonly push: PushService) {}

  // Public: the app needs the key before it can ask permission. Null = push off.
  @Get('key')
  key() {
    return { publicKey: this.push.publicKey(), enabled: this.push.enabled() };
  }

  @Post('subscribe')
  @UseGuards(SupabaseAuthGuard)
  subscribe(
    @CurrentOrg() orgId: string,
    @CurrentUser() auth: AuthContext,
    @Body() dto: SubscribeDto,
  ) {
    return this.push.subscribe(orgId, auth.userId, dto);
  }

  @Delete('subscribe')
  @UseGuards(SupabaseAuthGuard)
  unsubscribe(@Body() dto: UnsubscribeDto) {
    return this.push.unsubscribe(dto.endpoint);
  }
}
