import { Controller, Post, Body, Logger, HttpCode, HttpStatus } from '@nestjs/common';
import { McpService } from './mcp.service';
import { 
    SmartAnalyzeDto, 
    SmartAnalysisResponse, 
    GenerateDockerfileDto, 
    DockerfileGenerationResponse 
} from './dto/smart-analysis.dto';

/**
 * McpController - Smart Repository Analysis with Context Locking
 * 
 * Endpoints:
 * - POST /analyze/smart: Context-locked LLM-powered analysis
 * - POST /generate/dockerfile: Generate and push Dockerfile to repository
 */
@Controller('mcp')
export class McpController {
    private readonly logger = new Logger(McpController.name);

    constructor(
        private readonly mcpService: McpService,
    ) { }

    /**
     * Smart repository analysis with context locking
     * Uses MCP tools + LLM for zero-hardcoding extraction
     * 
     * Context Locking:
     * - Repository is locked via owner/repo params
     * - Branch is locked via branch param
     * 
     * Returns exact JSON structure expected by frontend
     */
    @Post('analyze/smart')
    @HttpCode(HttpStatus.OK)
    async smartAnalyze(@Body() dto: SmartAnalyzeDto): Promise<SmartAnalysisResponse> {
        this.logger.log(`🧠 Smart analysis: ${dto.repository} @ ${dto.branch}`);

        const result = await this.mcpService.smartAnalyze(
            dto.token,
            dto.repository,
            dto.branch,
        );

        if (result.success) {
            this.logger.log(`✅ Smart analysis complete: ${result.duration}`);
        } else {
            this.logger.error(`❌ Smart analysis failed: ${result.error}`);
        }

        return result;
    }

    /**
     * Generate Dockerfile and .dockerignore, then push to repository
     * Uses analysis result to generate intelligent, language-specific Dockerfile
     * 
     * MCP Tools Used:
     * - create_or_update_file: Push files to repository
     */
    @Post('generate/dockerfile')
    @HttpCode(HttpStatus.OK)
    async generateDockerfile(@Body() dto: GenerateDockerfileDto): Promise<DockerfileGenerationResponse> {
        this.logger.log(`🐳 Dockerfile generation: ${dto.repository} @ ${dto.branch}`);

        const result = await this.mcpService.generateAndPushDockerfile(
            dto.token,
            dto.repository,
            dto.branch,
            dto.analysisResult,
        );

        if (result.success) {
            this.logger.log(`✅ Dockerfile generated and pushed: ${result.files_created.join(', ')}`);
        } else {
            this.logger.error(`❌ Dockerfile generation failed: ${result.error}`);
        }

        return result;
    }
}
