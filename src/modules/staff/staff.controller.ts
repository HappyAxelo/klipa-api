import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard, AuthContext } from '../../common/auth/supabase.guard';
import { CurrentOrg, CurrentUser } from '../../common/auth/current-user.decorator';
import { StaffService } from './staff.service';
import { InviteDto } from './dto/invite.dto';

@Controller('v1/staff')
@UseGuards(SupabaseAuthGuard)
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  // Members + pending invitations for the current org.
  @Get()
  list(@CurrentOrg() orgId: string) {
    return this.staff.list(orgId);
  }

  // Owner/admin invites someone by email.
  @Post('invite')
  invite(
    @CurrentOrg() orgId: string,
    @CurrentUser() auth: AuthContext,
    @Body() dto: InviteDto,
  ) {
    return this.staff.invite(orgId, auth.role, dto);
  }

  // Owner/admin revokes a pending invitation.
  @Delete('invitations/:id')
  revoke(
    @CurrentOrg() orgId: string,
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ) {
    return this.staff.revoke(orgId, auth.role, id);
  }

  // Owner/admin removes a member.
  @Delete('members/:id')
  removeMember(
    @CurrentOrg() orgId: string,
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ) {
    return this.staff.removeMember(orgId, auth, id);
  }

  // Pending invitations addressed to the signed-in user (no org needed).
  @Get('invitations/mine')
  myInvitations(@CurrentUser() auth: AuthContext) {
    return this.staff.myInvitations(auth.email);
  }

  // The signed-in user accepts an invitation and joins that org.
  @Post('invitations/:id/accept')
  accept(@CurrentUser() auth: AuthContext, @Param('id') id: string) {
    return this.staff.accept(auth, id);
  }
}
