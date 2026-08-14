import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
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
  register(@Body() body: CredentialsBody) {
    const { email, password } = validateCredentials(body);
    return this.auth.register(email, password);
  }

  @Post('login')
  login(@Body() body: CredentialsBody) {
    const { email, password } = validateCredentials(body);
    return this.auth.login(email, password);
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
