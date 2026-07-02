import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/auth/supabase.guard';
import { CurrentOrg } from '../../common/auth/current-user.decorator';
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

  // Conversational question. Falls back to computed answers when AI is off.
  @Post('ask')
  async ask(@CurrentOrg() orgId: string, @Body() dto: AskDto) {
    return jsonSafe(await this.assistant.ask(orgId, dto.question));
  }
}
