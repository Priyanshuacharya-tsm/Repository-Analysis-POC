import { Controller, Post, Body, Logger, HttpCode, HttpStatus } from '@nestjs/common';
import { McpService, RepositoryAnalysis } from './mcp.service';
import { GeminiService } from '../gemini/gemini.service';
import { AnalyzeRepoDto } from './dto/analyze-repo.dto';

/**
 * McpController - Returns structured JSON analysis
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
}
