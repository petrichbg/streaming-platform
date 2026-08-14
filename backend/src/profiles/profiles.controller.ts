import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt-auth.guard';
import { ProfilesService } from './profiles.service';

interface CreateProfileBody {
  name?: string;
  isKid?: boolean;
  maxRating?: string;
}

interface UpdateProfileBody {
  name?: string;
  isKid?: boolean;
  maxRating?: string | null;
}

interface SessionBody {
  pin?: string;
}

interface PinBody {
  pin?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('profiles')
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Exchanges the current session for one bound to this profile.
   *
   * The parental-control cap travels in the token, so switching profile means
   * getting a new one. Ownership is checked first -- findOneForUser 404s for
   * a profile on another account, so a session cannot be bound to a profile
   * the caller does not have.
   *
   * A profile with a PIN can only be entered by presenting it, which is what
   * makes the rating cap hold against someone who knows where the profile
   * menu is. Without a PIN a profile stays open to anyone with a session on
   * the account -- that is the account owner's choice to make.
   */
  @Post(':id/session')
  async createSession(@Req() req: any, @Param('id') id: string, @Body() body: SessionBody) {
    const profile = await this.profiles.authorizeBinding(req.user.sub, id, body?.pin);

    const payload: JwtPayload = {
      sub: req.user.sub,
      email: req.user.email,
      isAdmin: req.user.isAdmin,
      profileId: profile.id,
      sv: req.user.sv,
    };

    return {
      accessToken: this.jwt.sign(payload),
      profile: { id: profile.id, name: profile.name, maxRating: profile.maxRating },
    };
  }

  @Post()
  async create(@Req() req: any, @Body() body: CreateProfileBody) {
    // Otherwise a restricted session could mint itself an unrestricted
    // profile and walk straight around the cap.
    await this.profiles.assertSessionMayManage(req.user);

    const name = body.name?.trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    return this.profiles.create(req.user.sub, {
      name,
      isKid: body.isKid,
      maxRating: body.maxRating,
    });
  }

  /** Locks a profile behind a PIN, or replaces the PIN it already has. */
  @Post(':id/pin')
  async setPin(@Req() req: any, @Param('id') id: string, @Body() body: PinBody) {
    await this.profiles.assertSessionMayManage(req.user);
    if (!body?.pin) {
      throw new BadRequestException('pin is required');
    }
    await this.profiles.setPin(req.user.sub, id, body.pin);
    return { ok: true };
  }

  @Delete(':id/pin')
  async clearPin(@Req() req: any, @Param('id') id: string) {
    await this.profiles.assertSessionMayManage(req.user);
    await this.profiles.clearPin(req.user.sub, id);
    return { ok: true };
  }

  @Get()
  findAll(@Req() req: any) {
    return this.profiles.findAllForUser(req.user.sub);
  }

  @Get(':id')
  findOne(@Req() req: any, @Param('id') id: string) {
    return this.profiles.findOneForUser(req.user.sub, id);
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: UpdateProfileBody) {
    await this.profiles.assertSessionMayManage(req.user);

    const name = body.name?.trim();
    if (body.name !== undefined && !name) {
      throw new BadRequestException('name cannot be empty');
    }

    return this.profiles.update(req.user.sub, id, {
      ...(name !== undefined ? { name } : {}),
      ...(body.isKid !== undefined ? { isKid: body.isKid } : {}),
      // An explicit null means "remove the cap"; leaving the key out means
      // "do not touch it", so the two cannot be collapsed.
      ...(body.maxRating !== undefined ? { maxRating: body.maxRating } : {}),
    });
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    // Deleting the locked profile is another way around it -- the cap must
    // survive the restricted session, not just the front door.
    await this.profiles.assertSessionMayManage(req.user);
    return this.profiles.remove(req.user.sub, id);
  }
}
