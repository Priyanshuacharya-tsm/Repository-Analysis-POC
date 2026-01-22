import { Controller, Get, Post, Query, Body, Res, Logger, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService, GitHubRepository } from './auth.service';

/**
 * AuthController handles GitHub OAuth endpoints and user data.
 * - GET /auth/login: Initiates OAuth flow by redirecting to GitHub
 * - GET /auth/callback: Handles OAuth callback and exchanges code for token
 * - POST /auth/repositories: Fetches user's repositories using their token
 */
@Controller('auth')
export class AuthController {
    private readonly logger = new Logger(AuthController.name);

    constructor(private readonly authService: AuthService) { }

    /**
     * Initiates the GitHub OAuth flow.
     * Redirects the user to GitHub's authorization page.
     */
    @Get('login')
    login(@Res() res: Response): void {
        this.logger.log('🔐 Initiating GitHub OAuth flow...');

        const authUrl = this.authService.getAuthorizationUrl();
        res.redirect(HttpStatus.FOUND, authUrl);
    }

    /**
     * Handles the OAuth callback from GitHub.
     * Exchanges the authorization code for an access token,
     * then redirects to the frontend with the token.
     */
    @Get('callback')
    async callback(
        @Query('code') code: string,
        @Query('error') error: string,
        @Query('error_description') errorDescription: string,
        @Res() res: Response,
    ): Promise<void> {
        const frontendUrl = this.authService.getFrontendUrl();

        // Handle OAuth errors from GitHub
        if (error) {
            this.logger.error(`GitHub OAuth error: ${error} - ${errorDescription}`);
            const errorRedirect = `${frontendUrl}?error=${encodeURIComponent(errorDescription || error)}`;
            res.redirect(HttpStatus.FOUND, errorRedirect);
            return;
        }

        // Validate code presence
        if (!code) {
            this.logger.error('No authorization code received from GitHub');
            const errorRedirect = `${frontendUrl}?error=${encodeURIComponent('No authorization code received')}`;
            res.redirect(HttpStatus.FOUND, errorRedirect);
            return;
        }

        try {
            this.logger.log('📥 Received OAuth callback, exchanging code for token...');

            // Exchange code for access token and fetch user info
            const { accessToken, user } = await this.authService.exchangeCodeForToken(code);

            this.logger.log(`✅ Authentication successful for user: ${user.login}`);

            // Redirect to frontend with token and user info in URL params
            // Note: For production, consider using secure httpOnly cookies or session storage
            const successRedirect = `${frontendUrl}?token=${accessToken}&username=${encodeURIComponent(user.login)}&avatar=${encodeURIComponent(user.avatar_url)}`;

            res.redirect(HttpStatus.FOUND, successRedirect);
        } catch (err) {
            this.logger.error(`Authentication failed: ${(err as Error).message}`);
            const errorRedirect = `${frontendUrl}?error=${encodeURIComponent('Authentication failed. Please try again.')}`;
            res.redirect(HttpStatus.FOUND, errorRedirect);
        }
    }

    /**
     * Fetches the authenticated user's repositories.
     * Requires the user's access token in the request body.
     */
    @Post('repositories')
    async getRepositories(
        @Body('token') token: string,
    ): Promise<{ success: boolean; repositories: GitHubRepository[] }> {
        this.logger.log('📁 Fetching user repositories...');

        if (!token) {
            this.logger.error('No token provided for repository fetch');
            return { success: false, repositories: [] };
        }

        try {
            const repositories = await this.authService.fetchUserRepositories(token);
            this.logger.log(`✅ Returned ${repositories.length} repositories`);

            return {
                success: true,
                repositories,
            };
        } catch (error) {
            this.logger.error(`Failed to fetch repositories: ${(error as Error).message}`);
            return { success: false, repositories: [] };
        }
    }
}
