import { Controller, Post, Body, Logger, HttpCode, HttpStatus } from '@nestjs/common';
import { McpService, RepositoryAnalysis } from './mcp.service';
import { GeminiService } from '../gemini/gemini.service';
import { AnalyzeRepoDto } from './dto/analyze-repo.dto';
import {
    RepoAnalysisResponse,
    DockerfileGenerationResponse,
} from './dto/repo-analysis-summary.dto';

/**
 * McpController - Returns structured JSON analysis
 * 
 * Endpoints:
 * - POST /analyze: Full analysis with AI documentation (legacy)
 * - POST /analyze/raw: Raw analysis without AI (legacy)
 * - POST /analyze/enhanced: Enhanced analysis with abstracted frontend response
 * - POST /generate/dockerfile: Generate and commit Dockerfile to repository
 */
@Controller('mcp')
export class McpController {
    private readonly logger = new Logger(McpController.name);

    constructor(
        private readonly mcpService: McpService,
        private readonly geminiService: GeminiService,
    ) { }

    /**
     * Full analysis with AI documentation
     */
    @Post('analyze')
    @HttpCode(HttpStatus.OK)
    async analyzeRepository(@Body() dto: AnalyzeRepoDto) {
        this.logger.log(`📊 Analyzing: ${dto.repository}`);
        const startTime = Date.now();

        const analysis = await this.mcpService.analyzeRepository(dto.token, dto.repository);
        const documentation = await this.geminiService.generateDocumentation(analysis);

        const duration = Date.now() - startTime;
        this.logger.log(`✅ Completed in ${duration}ms`);

        return {
            success: true,
            repository: dto.repository,
            duration: `${duration}ms`,
            // Structured analysis output
            analysis: {
                detected: analysis.detected,
                missing: analysis.missing,
                filesAnalyzed: Object.keys(analysis.files),
            },
            // AI-generated summary
            documentation,
            // Raw data for debugging
            raw: analysis,
        };
    }

    /**
     * Raw analysis without AI (faster)
     */
    @Post('analyze/raw')
    @HttpCode(HttpStatus.OK)
    async analyzeRepositoryRaw(@Body() dto: AnalyzeRepoDto) {
        this.logger.log(`🔍 Raw analysis: ${dto.repository}`);
        const startTime = Date.now();

        const analysis = await this.mcpService.analyzeRepository(dto.token, dto.repository);

        return {
            success: true,
            repository: dto.repository,
            duration: `${Date.now() - startTime}ms`,
            analysis: {
                detected: analysis.detected,
                missing: analysis.missing,
                filesAnalyzed: Object.keys(analysis.files),
            },
            raw: analysis,
        };
    }

    /**
     * Enhanced analysis with abstracted frontend response
     * Returns minimal, clean JSON structure for UI consumption
     */
    @Post('analyze/enhanced')
    @HttpCode(HttpStatus.OK)
    async analyzeRepositoryEnhanced(@Body() dto: AnalyzeRepoDto): Promise<RepoAnalysisResponse> {
        this.logger.log(`📊 Enhanced analysis: ${dto.repository}`);

        const result = await this.mcpService.analyzeRepositoryEnhanced(dto.token, dto.repository);

        this.logger.log(`✅ Enhanced analysis complete: ${result.duration}`);
        return result;
    }

    /**
     * Generate and commit Dockerfile to repository
     * Uses MCP create_or_update_file tool
     */
    @Post('generate/dockerfile')
    @HttpCode(HttpStatus.OK)
    async generateDockerfile(
        @Body() dto: AnalyzeRepoDto & { branch?: string },
    ): Promise<DockerfileGenerationResponse> {
        this.logger.log(`🐳 Generating Dockerfile for: ${dto.repository}`);

        const result = await this.mcpService.generateDockerfile(
            dto.token,
            dto.repository,
            dto.branch,
        );

        if (result.status === 'success') {
            this.logger.log(`✅ Dockerfile generated successfully`);
        } else {
            this.logger.error(`❌ Dockerfile generation failed: ${result.error_message}`);
        }

        return result;
    }
}
