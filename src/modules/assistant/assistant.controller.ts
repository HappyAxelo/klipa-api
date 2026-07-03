import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard, AuthContext } from '../../common/auth/supabase.guard';
import { CurrentOrg, CurrentUser } from '../../common/auth/current-user.decorator';
import { AssistantService } from './assistant.service';
import { AskDto } from './dto/ask.dto';
import { jsonSafe } from '../../common/money/money';

@Controller('v1/assistant')
@UseGuards(SupabaseAuthGuard)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  // Dashboard insight cards + tips (deterministic; always available).
  @Get('insights')
  async insights(@CurrentOrg() orgId: string) {
    return jsonSafe({
      aiEnabled: this.assistant.aiEnabled(),
      ...(await this.assistant.insights(orgId)),
    });
  }

  // Conversational question. Remembers the exchange; falls back to computed
  // answers when AI is off.
  @Post('ask')
  async ask(
    @CurrentOrg() orgId: string,
    @CurrentUser() auth: AuthContext,
    @Body() dto: AskDto,
  ) {
    return jsonSafe(await this.assistant.ask(orgId, auth.userId, dto.question));
  }

  // This user's recent conversation, oldest first (restores the chat UI).
  @Get('history')
  async history(@CurrentOrg() orgId: string, @CurrentUser() auth: AuthContext) {
    return jsonSafe(await this.assistant.history(orgId, auth.userId));
  }

  @Delete('history')
  async clear(@CurrentOrg() orgId: string, @CurrentUser() auth: AuthContext) {
    return jsonSafe(await this.assistant.clearHistory(orgId, auth.userId));
  }
}
