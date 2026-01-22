import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { GeminiModule } from '../gemini/gemini.module';

/**
 * McpModule encapsulates the core MCP spawner functionality.
 * Imports GeminiModule for AI documentation generation.
 */
@Module({
    imports: [GeminiModule],
    controllers: [McpController],
    providers: [McpService],
    exports: [McpService],
})
export class McpModule { }
