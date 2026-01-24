import { IsNotEmpty, Matches, IsOptional } from 'class-validator';

/**
 * DTO for smart repository analysis request
 * Includes context locking for repository and branch
 */
export class SmartAnalyzeDto {
    /**
     * GitHub personal access token for authentication
     */
    @IsNotEmpty({ message: 'GitHub token is required' })
    token: string;

    /**
     * Repository in format "owner/repo"
     * CONTEXT LOCK: Analysis is scoped to this repository only
     */
    @IsNotEmpty({ message: 'Repository is required' })
    @Matches(/^[^\/]+\/[^\/]+$/, { message: 'Repository must be in format "owner/repo"' })
    repository: string;

    /**
     * Branch name to analyze
     * CONTEXT LOCK: Analysis is scoped to this branch only
     */
    @IsNotEmpty({ message: 'Branch is required for context locking' })
    branch: string;
}

/**
 * Result of smart repository analysis
 * This is the exact JSON structure returned to the frontend
 * All fields are extracted by LLM from raw manifest file contents
 */
export interface SmartAnalysisResult {
    /**
     * Detected programming language
     * Values: "node" | "python" | "java" | "go" | "rust" | "ruby" | "php" | "dotnet" | "unknown"
     */
    detected_language: string;

    /**
     * Detected runtime/language version (e.g., "18.x", "3.11", "21")
     * Extracted from: engines.node, .nvmrc, go.mod, pom.xml, runtime.txt
     */
    detected_version: string | null;

    /**
     * Whether a Dockerfile exists in the repository
     */
    is_docker_present: boolean;

    /**
     * Path to Dockerfile if present (e.g., "./Dockerfile", "./docker/Dockerfile")
     */
    dockerfile_location: string | null;

    /**
     * Detected frameworks and libraries used in the project
     * Examples: ["NestJS", "Express.js", "React", "TypeORM", "Prisma"]
     */
    detected_frameworks: string[];

    /**
     * Key external dependencies (databases, caches, cloud SDKs ONLY)
     * Examples: ["pg", "redis", "aws-sdk", "mongodb"]
     * NOTE: Frameworks should NOT be included here
     */
    detected_dependencies: string[];

    /**
     * Detected start command from scripts.start, CMD, or Procfile
     */
    detected_start_cmd: string | null;

    /**
     * Detected build command from scripts.build or build tools
     */
    detected_build_cmd: string | null;

    /**
     * Required environment variables extracted from .env.example or .env.sample
     */
    env_vars_needed: string[];
}

/**
 * Full response wrapper for smart analysis endpoint
 */
export interface SmartAnalysisResponse {
    success: boolean;
    repository: string;
    branch: string;
    duration: string;
    analysis: SmartAnalysisResult;
    error?: string;
}

/**
 * DTO for Dockerfile generation request
 */
export class GenerateDockerfileDto {
    /**
     * GitHub personal access token for authentication
     */
    @IsNotEmpty({ message: 'GitHub token is required' })
    token: string;

    /**
     * Repository in format "owner/repo"
     */
    @IsNotEmpty({ message: 'Repository is required' })
    @Matches(/^[^\/]+\/[^\/]+$/, { message: 'Repository must be in format "owner/repo"' })
    repository: string;

    /**
     * Branch name to push Dockerfile to
     */
    @IsNotEmpty({ message: 'Branch is required' })
    branch: string;

    /**
     * Analysis result used to generate intelligent Dockerfile
     */
    @IsNotEmpty({ message: 'Analysis result is required' })
    analysisResult: SmartAnalysisResult;
}

/**
 * Response for Dockerfile generation endpoint
 */
export interface DockerfileGenerationResponse {
    success: boolean;
    repository: string;
    branch: string;
    duration: string;
    files_created: string[];
    dockerfile_content?: string;
    dockerignore_content?: string;
    error?: string;
}

/**
 * Internal type for file contents fetched via MCP
 */
export interface FetchedFiles {
    [filename: string]: string;
}
