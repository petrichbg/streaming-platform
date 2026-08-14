import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { ALLOWED_MAX_RATINGS } from '../catalog/ratings';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateProfileInput {
  name: string;
  isKid?: boolean;
  maxRating?: string;
}

export interface UpdateProfileInput {
  name?: string;
  isKid?: boolean;
  /** null clears the cap; undefined leaves it alone. */
  maxRating?: string | null;
}

/** Digits only, and long enough that guessing is not trivial. */
const PIN_PATTERN = /^\d{4,8}$/;

// A four-digit PIN is 10 000 guesses, which is nothing over a LAN without a
// brake. Attempts are counted per profile in memory: this resets on restart
// and is per-process, which is fine for a single-instance server and is the
// thing to revisit if the API is ever run more than once.
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

interface AttemptRecord {
  failures: number;
  lockedUntil: number;
}

@Injectable()
export class ProfilesService {
  private readonly pinAttempts = new Map<string, AttemptRecord>();

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, input: CreateProfileInput) {
    try {
      return await this.prisma.profile.create({
        data: {
          userId,
          name: input.name,
          isKid: input.isKid ?? false,
          maxRating: input.maxRating,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A profile with this name already exists on this account');
      }
      throw err;
    }
  }

  /**
   * Fields are listed explicitly rather than returning the row: the default
   * shape includes pinHash, and a bcrypt hash has no business reaching the
   * browser. `hasPin` is what the client actually needs, so it knows when to
   * ask for one.
   */
  async findAllForUser(userId: string) {
    const profiles = await this.prisma.profile.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        isKid: true,
        maxRating: true,
        createdAt: true,
        pinHash: true,
      },
    });

    return profiles.map(({ pinHash, ...profile }) => ({
      ...profile,
      hasPin: pinHash !== null,
    }));
  }

  async findOneForUser(userId: string, id: string) {
    const profile = await this.prisma.profile.findUnique({ where: { id } });
    // Same 404 whether the profile doesn't exist or belongs to someone
    // else — don't leak existence of other accounts' profiles.
    if (!profile || profile.userId !== userId) {
      throw new NotFoundException(`Profile ${id} not found`);
    }
    return profile;
  }

  /**
   * Renames a profile or changes its rating cap.
   *
   * `maxRating` is validated rather than stored as given: an unrecognised cap
   * is treated by isRatingAllowed as no cap at all, so a typo would silently
   * switch the parental control off instead of failing. Passing null clears
   * the cap, which is a different thing from omitting the field.
   */
  async update(userId: string, id: string, input: UpdateProfileInput) {
    await this.findOneForUser(userId, id);

    if (input.maxRating !== undefined && input.maxRating !== null) {
      const match = ALLOWED_MAX_RATINGS.find(
        (rating) => rating.toUpperCase() === input.maxRating!.trim().toUpperCase(),
      );
      if (!match) {
        throw new BadRequestException(
          `maxRating must be one of: ${ALLOWED_MAX_RATINGS.join(', ')}`,
        );
      }
      input = { ...input, maxRating: match };
    }

    try {
      return await this.prisma.profile.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.isKid !== undefined ? { isKid: input.isKid } : {}),
          ...(input.maxRating !== undefined ? { maxRating: input.maxRating } : {}),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A profile with this name already exists on this account');
      }
      throw err;
    }
  }

  /**
   * Deletes a profile together with what belongs to it.
   *
   * The foreign keys are RESTRICT, so deleting a profile that had ever been
   * watched with used to fail with a bare 500. Watch progress and watchlist
   * entries are meaningless without the profile they belong to, so they go
   * with it -- in one transaction, so a half-deleted profile is not possible.
   */
  async remove(userId: string, id: string): Promise<void> {
    await this.findOneForUser(userId, id);

    await this.prisma.$transaction([
      this.prisma.watchProgress.deleteMany({ where: { profileId: id } }),
      this.prisma.watchlistItem.deleteMany({ where: { profileId: id } }),
      this.prisma.profile.delete({ where: { id } }),
    ]);

    this.pinAttempts.delete(id);
  }

  /**
   * Guards everything that could be used to walk around a PIN.
   *
   * Locking the adult profile achieves nothing if a restricted session can
   * simply create a fresh unrestricted profile, delete the lock, or set a new
   * PIN of its own choosing. So profile management requires a session that is
   * not itself restricted -- either unbound (which took the account password
   * to obtain) or bound to a profile with no rating cap.
   */
  async assertSessionMayManage(user: { profileId?: string } | undefined): Promise<void> {
    if (!user?.profileId) return;

    const profile = await this.prisma.profile.findUnique({
      where: { id: user.profileId },
      select: { maxRating: true },
    });

    if (profile?.maxRating) {
      throw new ForbiddenException(
        'This profile is restricted and cannot manage profiles or PINs',
      );
    }
  }

  async setPin(userId: string, id: string, pin: string): Promise<void> {
    if (!PIN_PATTERN.test(pin)) {
      throw new BadRequestException('PIN must be 4 to 8 digits');
    }
    await this.findOneForUser(userId, id);
    await this.prisma.profile.update({
      where: { id },
      data: { pinHash: await bcrypt.hash(pin, 12) },
    });
    this.pinAttempts.delete(id);
  }

  async clearPin(userId: string, id: string): Promise<void> {
    await this.findOneForUser(userId, id);
    await this.prisma.profile.update({ where: { id }, data: { pinHash: null } });
    this.pinAttempts.delete(id);
  }

  /**
   * Resolves the profile a session is being bound to, demanding the PIN when
   * one is set. This is the only door into a locked profile.
   */
  async authorizeBinding(userId: string, id: string, pin?: string) {
    const profile = await this.findOneForUser(userId, id);
    if (!profile.pinHash) return profile;

    const record = this.pinAttempts.get(id);
    if (record && record.lockedUntil > Date.now()) {
      const seconds = Math.ceil((record.lockedUntil - Date.now()) / 1000);
      throw new UnauthorizedException(`Too many attempts. Try again in ${seconds}s`);
    }

    if (!pin || !(await bcrypt.compare(pin, profile.pinHash))) {
      const failures = (record?.failures ?? 0) + 1;
      this.pinAttempts.set(id, {
        failures,
        lockedUntil: failures >= MAX_PIN_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0,
      });
      throw new UnauthorizedException('Incorrect PIN');
    }

    this.pinAttempts.delete(id);
    return profile;
  }
}
