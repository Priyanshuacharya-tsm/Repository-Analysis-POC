import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * AuthModule encapsulates all GitHub OAuth authentication logic.
 * Handles the complete OAuth flow including login initiation and token exchange.
 */
@Module({
    controllers: [AuthController],
    providers: [AuthService],
    exports: [AuthService],
})
export class AuthModule { }
