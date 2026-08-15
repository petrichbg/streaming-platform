import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AdminGuard } from './admin.guard';
import { JwtAuthGuard } from './jwt-auth.guard';

interface CredentialsBody {
  email?: string;
  password?: string;
}

interface ChangePasswordBody { currentPassword?: string; newPassword?: string }

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Req() req: any, @Body() body: CredentialsBody) {
    const { email, password } = validateCredentials(body);
    return this.auth.register(email, password, sessionContext(req));
  }

  @Post('login')
  login(@Req() req: any, @Body() body: CredentialsBody) {
    const { email, password } = validateCredentials(body);
    return this.auth.login(email, password, sessionContext(req));
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: any) {
    return req.user;
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(@Req() req: any, @Body() body: ChangePasswordBody) {
    if (!body.currentPassword || !body.newPassword || body.newPassword.length < 10) {
      throw new BadRequestException('Current password and a new password of at least 10 characters are required');
    }
    return this.auth.changePassword(req.user.sub, body.currentPassword, body.newPassword);
  }

  @UseGuards(JwtAuthGuard)
  @Post('revoke-sessions')
  revokeOwnSessions(@Req() req: any) {
    return this.auth.revokeSessions(req.user.sub);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('users')
  users() {
    return this.auth.listUsers();
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('sessions')
  sessions() { return this.auth.listSessions(); }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch('users/:userId/role')
  updateRole(
    @Req() req: any,
    @Param('userId') userId: string,
    @Body() body: { isAdmin?: boolean },
  ) {
    if (typeof body.isAdmin !== 'boolean') {
      throw new BadRequestException('isAdmin must be a boolean');
    }
    return this.auth.updateUserRole(req.user.sub, userId, body.isAdmin);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('users/:userId/revoke-sessions')
  revokeUserSessions(@Param('userId') userId: string) {
    return this.auth.revokeSessions(userId);
  }
}

function sessionContext(req: any) {
  return { userAgent: String(req.headers?.['user-agent'] ?? '').slice(0, 300) || null, ipAddress: String(req.ip ?? req.socket?.remoteAddress ?? '').slice(0, 80) || null };
}

function validateCredentials(body: CredentialsBody): { email: string; password: string } {
  const email = body.email?.trim().toLowerCase();
  const password = body.password;

  if (!email || !email.includes('@')) {
    throw new BadRequestException('Valid email is required');
  }
  if (!password || password.length < 8) {
    throw new BadRequestException('Password must be at least 8 characters');
  }

  return { email, password };
}
