import { IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * DTO for repository analysis requests.
 * Validates the repository format and token presence.
 */
export class AnalyzeRepoDto {
    @IsString()
    @IsNotEmpty({ message: 'Repository name is required' })
    @Matches(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, {
        message: 'Repository must be in "owner/repo" format (e.g., "facebook/react")',
    })
    repository: string;

    @IsString()
    @IsNotEmpty({ message: 'Access token is required' })
    token: string;
}
