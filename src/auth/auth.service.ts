import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * AuthService handles GitHub OAuth authentication flow.
 * Responsible for generating authorization URLs, exchanging codes for tokens,
 * and fetching user repository data.
 */
@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly frontendUrl: string;
    private readonly backendUrl: string;

    constructor(private readonly configService: ConfigService) {
        this.clientId = this.configService.get<string>('GITHUB_CLIENT_ID') || '';
        this.clientSecret = this.configService.get<string>('GITHUB_CLIENT_SECRET') || '';
        this.frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';
        this.backendUrl = this.configService.get<string>('BACKEND_URL') || 'http://localhost:3000';

        this.logger.log(`🔧 OAuth Config - Client ID: ${this.clientId ? '✓ Set' : '✗ Missing'}`);
        this.logger.log(`🔧 Frontend URL: ${this.frontendUrl}`);
        this.logger.log(`🔧 Backend URL: ${this.backendUrl}`);

        if (!this.clientId || !this.clientSecret) {
            this.logger.warn('⚠️ GitHub OAuth credentials not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env');
        }
    }

    /**
     * Generates the GitHub OAuth authorization URL.
     * Scope 'repo' grants access to private and public repositories.
     */
    getAuthorizationUrl(): string {
        const redirectUri = `${this.backendUrl}/auth/callback`;

        const params = new URLSearchParams({
            client_id: this.clientId,
            scope: 'repo read:user',
            redirect_uri: redirectUri,
        });

        const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
        this.logger.log(`🔐 Generated OAuth URL with redirect to: ${redirectUri}`);

        return authUrl;
    }

    /**
     * Exchanges the OAuth authorization code for an access token.
     * @param code - The authorization code from GitHub callback
     * @returns Object containing access_token and user info
     */
    async exchangeCodeForToken(code: string): Promise<{ accessToken: string; user: GitHubUser }> {
        this.logger.log('🔄 Exchanging authorization code for access token...');

        try {
            // Step 1: Exchange code for access token
            const tokenResponse = await axios.post<GitHubTokenResponse>(
                'https://github.com/login/oauth/access_token',
                {
                    client_id: this.clientId,
                    client_secret: this.clientSecret,
                    code,
                },
                {
                    headers: {
                        Accept: 'application/json',
                    },
                },
            );

            const { access_token, error, error_description } = tokenResponse.data;

            if (error || !access_token) {
                this.logger.error(`❌ Token exchange failed: ${error_description || error}`);
                throw new UnauthorizedException(error_description || 'Failed to exchange code for token');
            }

            this.logger.log('✅ Successfully obtained access token');

            // Step 2: Fetch user information
            const user = await this.fetchUserInfo(access_token);

            return {
                accessToken: access_token,
                user,
            };
        } catch (error) {
            if (error instanceof UnauthorizedException) {
                throw error;
            }
            this.logger.error(`❌ OAuth exchange error: ${(error as Error).message}`);
            throw new UnauthorizedException('Authentication failed. Please try again.');
        }
    }

    /**
     * Fetches the authenticated user's GitHub profile.
     * @param accessToken - The GitHub access token
     */
    private async fetchUserInfo(accessToken: string): Promise<GitHubUser> {
        this.logger.log('👤 Fetching user profile from GitHub...');

        const response = await axios.get<GitHubUser>('https://api.github.com/user', {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/vnd.github.v3+json',
            },
        });

        this.logger.log(`✅ Fetched user profile for: ${response.data.login}`);

        return {
            login: response.data.login,
            id: response.data.id,
            avatar_url: response.data.avatar_url,
            name: response.data.name,
        };
    }

    /**
     * Fetches all repositories accessible to the authenticated user.
     * Includes both owned repos and repos the user has access to.
     * @param accessToken - The GitHub access token
     */
    async fetchUserRepositories(accessToken: string): Promise<GitHubRepository[]> {
        this.logger.log('📁 Fetching user repositories from GitHub...');

        try {
            const allRepos: GitHubRepository[] = [];
            let page = 1;
            const perPage = 100;

            // Paginate through all repos
            while (true) {
                const response = await axios.get<GitHubApiRepository[]>(
                    `https://api.github.com/user/repos`,
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            Accept: 'application/vnd.github.v3+json',
                        },
                        params: {
                            visibility: 'all',
                            affiliation: 'owner,collaborator,organization_member',
                            sort: 'updated',
                            direction: 'desc',
                            per_page: perPage,
                            page,
                        },
                    },
                );

                if (response.data.length === 0) break;

                const repos = response.data.map((repo) => ({
                    id: repo.id,
                    name: repo.name,
                    full_name: repo.full_name,
                    description: repo.description,
                    private: repo.private,
                    html_url: repo.html_url,
                    language: repo.language,
                    stargazers_count: repo.stargazers_count,
                    forks_count: repo.forks_count,
                    updated_at: repo.updated_at,
                    owner: {
                        login: repo.owner.login,
                        avatar_url: repo.owner.avatar_url,
                    },
                }));

                allRepos.push(...repos);

                if (response.data.length < perPage) break;
                page++;

                // Safety limit
                if (page > 10) break;
            }

            this.logger.log(`✅ Fetched ${allRepos.length} repositories`);
            return allRepos;
        } catch (error) {
            this.logger.error(`❌ Failed to fetch repositories: ${(error as Error).message}`);
            throw new UnauthorizedException('Failed to fetch repositories. Please re-authenticate.');
        }
    }

    /**
     * Fetches all branches for a specific repository.
     * @param accessToken - The GitHub access token
     * @param repository - Repository in "owner/repo" format
     */
    async fetchRepositoryBranches(accessToken: string, repository: string): Promise<GitHubBranch[]> {
        this.logger.log(`🌿 Fetching branches for repository: ${repository}`);

        try {
            const allBranches: GitHubBranch[] = [];
            let page = 1;
            const perPage = 100;

            // Paginate through all branches
            while (true) {
                const response = await axios.get<GitHubApiBranch[]>(
                    `https://api.github.com/repos/${repository}/branches`,
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            Accept: 'application/vnd.github.v3+json',
                        },
                        params: {
                            per_page: perPage,
                            page,
                        },
                    },
                );

                if (response.data.length === 0) break;

                const branches = response.data.map((branch) => ({
                    name: branch.name,
                    protected: branch.protected,
                }));

                allBranches.push(...branches);

                if (response.data.length < perPage) break;
                page++;

                // Safety limit
                if (page > 10) break;
            }

            this.logger.log(`✅ Fetched ${allBranches.length} branches for ${repository}`);
            return allBranches;
        } catch (error) {
            this.logger.error(`❌ Failed to fetch branches: ${(error as Error).message}`);
            throw new UnauthorizedException('Failed to fetch branches. Repository may not exist or you may not have access.');
        }
    }

    /**
     * Returns the frontend URL for redirect.
     */
    getFrontendUrl(): string {
        return this.frontendUrl;
    }
}

// Type Definitions
interface GitHubTokenResponse {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
}

interface GitHubUser {
    login: string;
    id: number;
    avatar_url: string;
    name: string | null;
}

interface GitHubApiRepository {
    id: number;
    name: string;
    full_name: string;
    description: string | null;
    private: boolean;
    html_url: string;
    language: string | null;
    stargazers_count: number;
    forks_count: number;
    updated_at: string;
    owner: {
        login: string;
        avatar_url: string;
    };
}

export interface GitHubRepository {
    id: number;
    name: string;
    full_name: string;
    description: string | null;
    private: boolean;
    html_url: string;
    language: string | null;
    stargazers_count: number;
    forks_count: number;
    updated_at: string;
    owner: {
        login: string;
        avatar_url: string;
    };
}

export interface GitHubBranch {
    name: string;
    protected: boolean;
}

interface GitHubApiBranch {
    name: string;
    protected: boolean;
    commit: {
        sha: string;
        url: string;
    };
}
